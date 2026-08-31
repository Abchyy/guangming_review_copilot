import {
  BODY_MAX_LENGTH,
  MODEL_SPECIALIST_IDS,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_MAX_PER_ARTICLE,
  SPECIALIST_TARGET_MODEL,
  TITLE_MAX_LENGTH,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  createReviewResponseSchema,
  findingSchema,
  parseLlmReviewOutput,
  parseSpecialistOrchestrationRun,
  parseWebEvidenceRun,
  ReviewProviderError,
  ReviewRequestError,
  type CanonicalArticle,
  type CreateReviewRequest,
  type CreateReviewResponse,
  type Finding,
  type ReviewCandidate,
  type SpecialistJudgment,
  type SpecialistOrchestrationRun,
  type SpecialistRetrievedEvidence,
  type SpecialistRuntime,
  type WebEvidenceCollector,
  type WebEvidenceRun,
} from "@grc/contracts";
import { canonicalizeArticle } from "./normalization";
import type { ReviewModel, ReviewPromptMode } from "@grc/providers";
import { LlmCandidateCache } from "@grc/providers";
import {
  attachApplicationCache,
  fallbackProvenance,
} from "@grc/providers";
import { PROMPT_VERSION, OUTPUT_SCHEMA_VERSION, getFallbackMode } from "@grc/providers";
import {
  fieldText,
  locateSourceSpan,
  assertSliceEqualsQuotedText,
} from "./span-locator";
import { buildCandidateCacheKey, hashCanonicalArticle } from "./article-hash";
import { buildFallbackRiskFindings } from "./fallback-risk";
import { getCorpusVersion } from "@grc/retrieval";
import { materializeLlmEvidence, ruleHitToFindingDraft } from "./evidence";
import { fuseFindings, type DraftFinding } from "./fusion";
import { rankFindings } from "./ranking";
import { retrieveCorpus } from "@grc/retrieval";
import { getRuleVersion, runRules } from "@grc/rules-engine";
import { applySeverityOverrides } from "./severity";

export type CreateReviewOptions = {
  promptMode?: ReviewPromptMode;
  useCache?: boolean;
  cache?: LlmCandidateCache | null;
  disableRules?: boolean;
  disableRetrieval?: boolean;
  /** Optional Web Evidence collector. Default off; review-core never calls a search vendor. */
  webEvidenceCollector?: WebEvidenceCollector | null;
  /** Optional specialist runtime. Default off; review-core never imports the orchestration package. */
  specialistRuntime?: SpecialistRuntime | null;
  /** Product-path wall clock. Official holdout must omit this. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

/** Product reviews must finish or degrade under the Next.js route cap. */
export const PRODUCT_REVIEW_DEADLINE_MS = 470_000;
export const PRODUCT_REVIEW_MAX_ELAPSED_MS = 480_000;
/** Product main-review output budget. Official holdout still uses DEEPSEEK_RETRY_POLICY.max_tokens. */
export const PRODUCT_REVIEW_MAX_TOKENS = 12_288;
export const PRODUCT_REVIEW_MAX_CANDIDATES = 20;
export const PRODUCT_REVIEW_MAX_ATTEMPTS = 2;
export const PRODUCT_REVIEW_SDK_MAX_RETRIES = 0;
export const PRODUCT_MAIN_REVIEW_BUDGET_MS = 300_000;
export const PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS = 150_000;
export const PRODUCT_WEB_EVIDENCE_BUDGET_MS = 10_000;
export const PRODUCT_SPECIALIST_BUDGET_MS = 150_000;
const PRODUCT_PHASE_BUDGET_TOTAL_MS =
  PRODUCT_MAIN_REVIEW_BUDGET_MS +
  PRODUCT_WEB_EVIDENCE_BUDGET_MS +
  PRODUCT_SPECIALIST_BUDGET_MS;
/** Leave time to assemble the response after abort so wall clock stays ≤ deadline. */
export const PRODUCT_REVIEW_SETTLE_MS = 1_000;

export function productAbortAtMs(deadlineMs: number): number {
  const settle = Math.min(PRODUCT_REVIEW_SETTLE_MS, Math.max(0, Math.trunc(deadlineMs / 4)));
  return Math.max(0, deadlineMs - settle);
}

export function productPhaseBudgetMs(configuredBudgetMs: number, deadlineMs: number): number {
  const usableMs = productAbortAtMs(deadlineMs);
  const scale = Math.min(1, usableMs / PRODUCT_PHASE_BUDGET_TOTAL_MS);
  return Math.max(0, Math.floor(configuredBudgetMs * scale));
}

function remainingDeadlineMs(startedAt: number, deadlineMs: number | undefined): number | undefined {
  if (deadlineMs == null) {
    return undefined;
  }
  return Math.max(0, deadlineMs - (Date.now() - startedAt));
}

function remainingPhaseBudgetMs(
  startedAt: number,
  deadlineMs: number | undefined,
  configuredBudgetMs: number,
): number | undefined {
  if (deadlineMs == null) {
    return undefined;
  }
  return Math.min(
    productPhaseBudgetMs(configuredBudgetMs, deadlineMs),
    remainingDeadlineMs(startedAt, deadlineMs) ?? 0,
  );
}

function canDegradeToRulesOnly(promptMode: ReviewPromptMode, error: unknown): boolean {
  return (
    promptMode === "copilot" &&
    getFallbackMode() !== "fail" &&
    !(error instanceof ReviewRequestError)
  );
}

function swallowLater(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined,
  );
}

/** Give abort-aware collectors one event-loop turn to return their own per-query status. */
function raceAbortAfterTurn<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => T,
): Promise<T> {
  if (!signal || !signal.aborted) {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (apply: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", abort);
        apply();
      };
      const abort = () => {
        swallowLater(work);
        timer = setTimeout(
          () =>
            finish(() => {
              try {
                resolve(onAbort());
              } catch (error) {
                reject(error);
              }
            }),
          0,
        );
      };
      signal?.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }
  swallowLater(work);
  return Promise.resolve().then(onAbort);
}

function linkReviewAbort(options: { deadlineMs?: number; signal?: AbortSignal }): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const abortAt =
    options.deadlineMs == null ? undefined : productAbortAtMs(options.deadlineMs);
  const timer =
    abortAt != null ? setTimeout(onParentAbort, abortAt) : undefined;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function linkPhaseAbort(parent: AbortSignal, timeoutMs: number | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (parent.aborted || timeoutMs === 0) {
    abort();
  } else {
    parent.addEventListener("abort", abort, { once: true });
  }
  const timer = timeoutMs != null && timeoutMs > 0 ? setTimeout(abort, timeoutMs) : undefined;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      parent.removeEventListener("abort", abort);
    },
  };
}


export async function createReview(
  input: CreateReviewRequest,
  model: ReviewModel,
  options: CreateReviewOptions = {},
): Promise<CreateReviewResponse> {
  const startedAt = Date.now();
  validateRequest(input);
  const abort = linkReviewAbort({
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  });
  try {
    return await createReviewWithSignal(input, model, options, startedAt, abort.signal);
  } finally {
    abort.cleanup();
  }
}

async function createReviewWithSignal(
  input: CreateReviewRequest,
  model: ReviewModel,
  options: CreateReviewOptions,
  startedAt: number,
  signal: AbortSignal,
): Promise<CreateReviewResponse> {

  const canonical = canonicalizeArticle(input.title, input.body);
  if (canonical.title.length === 0 || canonical.body.length === 0) {
    throw new ReviewRequestError("title and body must not be empty");
  }

  const article: CanonicalArticle = {
    title: canonical.title,
    body: canonical.body,
    version: 1,
  };

  const promptMode = options.promptMode ?? "copilot";
  const useRules = promptMode === "copilot" && options.disableRules !== true;
  const useRetrieval = promptMode === "copilot" && options.disableRetrieval !== true;
  const ruleHits = useRules ? runRules(article) : [];
  const retrieved = useRetrieval ? retrieveCorpus(article) : [];

  let rawCandidates: unknown;
  let cacheHit = false;
  const shouldCache = options.useCache === true && model.provider !== "fixture";
  const cache = shouldCache ? (options.cache ?? null) : null;
  let fallback = {
    used: false as boolean,
    mode: "none" as "none" | "rules_only",
    reason: null as string | null,
  };
  const articleHash = hashCanonicalArticle(article.title, article.body);
  const cacheKey = buildCandidateCacheKey({
    articleHash,
    provider: model.provider,
    model: model.model,
    promptVersion: PROMPT_VERSION,
    ruleVersion: getRuleVersion(),
    corpusVersion: getCorpusVersion(),
    outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
    promptMode,
  });

  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      rawCandidates = cached;
      cacheHit = true;
    }
  }

  if (!cacheHit) {
    const mainPhaseBudgetMs = remainingPhaseBudgetMs(
      startedAt,
      options.deadlineMs,
      PRODUCT_MAIN_REVIEW_BUDGET_MS,
    );
    const mainAbort = linkPhaseAbort(signal, mainPhaseBudgetMs);
    try {
      const remainingMainMs =
        mainPhaseBudgetMs ?? remainingDeadlineMs(startedAt, options.deadlineMs);
      const modelTimeoutMs =
        options.deadlineMs == null
          ? remainingMainMs
          : Math.min(
              remainingMainMs ?? PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS,
              PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS,
            );
      if (mainAbort.signal.aborted || modelTimeoutMs === 0) {
        throw new ReviewProviderError("Review deadline exceeded");
      }
      const reviewWork = model.review(article, {
        promptMode,
        ruleHits: ruleHits.map((hit) => ({
          rule_id: hit.rule_id,
          title: hit.title,
          excerpt: hit.source_span.quoted_text,
        })),
        retrievedSources: retrieved.map((item) => ({
          source_id: item.source_id,
          source_name: item.source_name,
          category: item.category,
          excerpt: item.excerpt,
        })),
        ...(options.deadlineMs != null || options.signal
          ? { signal: mainAbort.signal, timeoutMs: modelTimeoutMs }
          : {}),
        ...(options.deadlineMs != null
          ? {
              maxTokens: PRODUCT_REVIEW_MAX_TOKENS,
              maxAttempts: PRODUCT_REVIEW_MAX_ATTEMPTS,
              maxRetries: PRODUCT_REVIEW_SDK_MAX_RETRIES,
              fallbackToTextJson: true,
            }
          : {}),
      });
      rawCandidates = await raceAbortAfterTurn(
        reviewWork,
        options.deadlineMs != null || options.signal ? mainAbort.signal : undefined,
        () => {
          throw new ReviewProviderError("Review deadline exceeded");
        },
      );
    } catch (error) {
      const providerError =
        error instanceof ReviewProviderError
          ? error
          : error instanceof ReviewRequestError
            ? error
            : new ReviewProviderError("Review provider unavailable", error);
      if (!canDegradeToRulesOnly(promptMode, providerError)) {
        throw providerError;
      }
      fallback = {
        used: true,
        mode: "rules_only",
        reason: providerError.message,
      };
      rawCandidates = [];
    } finally {
      mainAbort.cleanup();
    }
    if (cache && !fallback.used && Array.isArray(rawCandidates)) {
      cache.set(cacheKey, {
        provider: model.provider,
        model: model.model,
        promptVersion: PROMPT_VERSION,
        ruleVersion: getRuleVersion(),
        corpusVersion: getCorpusVersion(),
        outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
        articleHash,
        candidates: rawCandidates as ReviewCandidate[],
      });
    }
  }

  const applicationCache = { enabled: shouldCache, hit: cacheHit };
  const provenance = cacheHit
    ? fallbackProvenance({
        adapterProvider: model.provider,
        requestedModel: model.model,
        applicationCache,
      })
    : attachApplicationCache(
        model.consumeLastProvenance?.() ??
          fallbackProvenance({
            adapterProvider: model.provider,
            requestedModel: model.model,
            applicationCache,
            ...(fallback.used
              ? {
                  failureError: fallback.reason ?? "Review provider unavailable",
                  failureLatencyMs: Date.now() - startedAt,
                }
              : {}),
          }),
        applicationCache,
      );

  let candidates: ReviewCandidate[] = [];
  try {
    candidates = parseLlmReviewOutput({ candidates: rawCandidates }).candidates;
  } catch (error) {
    if (!canDegradeToRulesOnly(promptMode, error)) {
      throw error;
    }
    fallback = {
      used: true,
      mode: "rules_only",
      reason: error instanceof Error ? error.message : "Provider output failed schema validation",
    };
  }
  const limited = candidates.slice(
    0,
    options.deadlineMs != null ? PRODUCT_REVIEW_MAX_CANDIDATES : 20,
  );
  const llmDrafts: DraftFinding[] = [];
  let dropped = 0;

  for (const candidate of limited) {
    const span = locateSourceSpan(article, candidate.source);
    if (!span) {
      dropped += 1;
      continue;
    }
    const text = fieldText(article, span.field);
    assertSliceEqualsQuotedText(text, span);
    const materialized = materializeLlmEvidence(article, candidate);
    llmDrafts.push({
      type: candidate.type,
      severity: candidate.severity,
      source_span: span,
      title: candidate.title,
      reason: candidate.reason,
      suggestion: candidate.suggestion,
      confidence: candidate.confidence,
      evidence: materialized.evidence,
      status: "pending",
      requires_verification: materialized.requires_verification,
    });
  }

  const ruleDrafts = ruleHits.map(ruleHitToFindingDraft);
  const fallbackRiskDrafts = fallback.used ? buildFallbackRiskFindings(article) : [];
  const deterministicDrafts = [...ruleDrafts, ...fallbackRiskDrafts];
  const fused =
    promptMode === "baseline" ? llmDrafts : fuseFindings(deterministicDrafts, llmDrafts);
  const overridden = applySeverityOverrides(fused);
  const ranked = rankFindings(overridden);
  const findings: Finding[] = ranked.map((item, index) =>
    findingSchema.parse({
      ...item,
      finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
    }),
  );

  const webAbort = linkPhaseAbort(
    signal,
    remainingPhaseBudgetMs(startedAt, options.deadlineMs, PRODUCT_WEB_EVIDENCE_BUDGET_MS),
  );
  let webEvidence: WebEvidenceRun | undefined;
  try {
    webEvidence = await collectWebEvidence(
      options.webEvidenceCollector,
      article,
      findings,
      webAbort.signal,
    );
  } finally {
    webAbort.cleanup();
  }

  const specialistAbort = linkPhaseAbort(
    signal,
    remainingPhaseBudgetMs(startedAt, options.deadlineMs, PRODUCT_SPECIALIST_BUDGET_MS),
  );
  let specialistRun: SpecialistOrchestrationRun | undefined;
  try {
    specialistRun = await runSpecialists(
      options.specialistRuntime,
      article,
      findings,
      retrieved.map((item) => ({
        source_id: item.source_id,
        source_name: item.source_name,
        source_url: item.source_url,
        authority_level: item.authority_level,
        published_at: item.published_at,
        valid_from: item.valid_from,
        valid_to: item.valid_to,
        excerpt: item.excerpt,
        match_rank: item.match_rank,
        trigger: item.trigger,
      })),
      webEvidence,
      specialistAbort.signal,
    );
  } finally {
    specialistAbort.cleanup();
  }
  const finalized = specialistRun
    ? applySpecialistJudgments(findings, specialistRun)
    : findings;

  const response: CreateReviewResponse = {
    review_id: crypto.randomUUID(),
    article,
    findings: finalized,
    pipeline: {
      provider: model.provider,
      model: model.model,
      candidate_count: limited.length,
      located_count: findings.length,
      dropped_count: dropped,
      elapsed_ms: Date.now() - startedAt,
      provenance,
      fallback,
      specialists_enabled: specialistRun != null,
      ...(specialistRun ? { specialist_orchestration: specialistRun } : {}),
      ...(webEvidence ? { web_evidence: webEvidence } : {}),
    },
  };

  return createReviewResponseSchema.parse(response);
}

async function collectWebEvidence(
  collector: WebEvidenceCollector | null | undefined,
  article: CanonicalArticle,
  findings: Finding[],
  signal?: AbortSignal,
): Promise<WebEvidenceRun | undefined> {
  if (!collector) {
    return undefined;
  }
  if (signal?.aborted) {
    return parseWebEvidenceRun({ enabled: true, query_count: 0, results: [] });
  }
  try {
    return parseWebEvidenceRun(
      await raceAbortAfterTurn(collector.collect({ article, findings, signal }), signal, () => ({
        enabled: true as const,
        query_count: 0,
        results: [],
      })),
    );
  } catch {
    return parseWebEvidenceRun({
      enabled: true,
      query_count: 0,
      results: [
        {
          evidence: [],
          status: "unverified",
          error_class: "provider_failure",
          message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
          provenance: {
            provider_id: "web-evidence-collector",
            provider_kind: "unavailable",
            live_network: false,
            retrieved_at: new Date().toISOString(),
            query_text: "",
            fact_category: null,
          },
        },
      ],
    });
  }
}

async function runSpecialists(
  runtime: SpecialistRuntime | null | undefined,
  article: CanonicalArticle,
  findings: Finding[],
  retrieved: readonly SpecialistRetrievedEvidence[],
  webEvidence: WebEvidenceRun | undefined,
  signal?: AbortSignal,
): Promise<SpecialistOrchestrationRun | undefined> {
  if (!runtime) {
    return undefined;
  }
  try {
    return parseSpecialistOrchestrationRun(
      await runtime.orchestrate({
        article,
        findings,
        retrievedEvidence: retrieved,
        webEvidence,
        signal,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : SPECIALIST_FAILURE_MESSAGE;
    return parseSpecialistOrchestrationRun({
      enabled: true,
      target_model: SPECIALIST_TARGET_MODEL,
      dispatched: [],
      skipped: [],
      budget: { max_specialists: SPECIALIST_MAX_PER_ARTICLE, used: 0 },
      results: [],
      judgments: findings
        .filter((item) => item.type !== "basic_text")
        .map((item) => ({
          field: item.source_span.field,
          paragraph_index: item.source_span.paragraph_index,
          quoted_text: item.source_span.quoted_text,
          decision: "verify" as const,
          reason: SPECIALIST_FAILURE_MESSAGE,
          specialist_ids: [...MODEL_SPECIALIST_IDS],
          requires_verification: true,
        })),
      warnings: [message],
    });
  }
}

function matchingJudgment(
  finding: Finding,
  judgments: readonly SpecialistJudgment[],
): SpecialistJudgment | undefined {
  return judgments.find(
    (item) =>
      item.field === finding.source_span.field &&
      item.paragraph_index === finding.source_span.paragraph_index &&
      item.quoted_text === finding.source_span.quoted_text,
  );
}

function applySpecialistJudgments(
  findings: Finding[],
  run: SpecialistOrchestrationRun,
): Finding[] {
  return findings.map((finding) => {
    const judgment = matchingJudgment(finding, run.judgments);
    if (!judgment || judgment.decision === "keep") {
      return finding;
    }
    return findingSchema.parse({
      ...finding,
      status: "verify",
      requires_verification: true,
    });
  });
}

function validateRequest(input: CreateReviewRequest): void {
  if (input.title.length > TITLE_MAX_LENGTH) {
    throw new ReviewRequestError(
      `title exceeds ${TITLE_MAX_LENGTH} UTF-16 code units`,
    );
  }
  if (input.body.length > BODY_MAX_LENGTH) {
    throw new ReviewRequestError(
      `body exceeds ${BODY_MAX_LENGTH} UTF-16 code units`,
    );
  }
}

export const createReviewPipeline = createReview;
