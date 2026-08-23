import {
  BODY_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  createReviewResponseSchema,
  ReviewProviderError,
  ReviewRequestError,
  findingSchema,
  parseLlmReviewOutput,
  type CanonicalArticle,
  type CreateReviewRequest,
  type CreateReviewResponse,
  type Finding,
  type ReviewCandidate,
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
};


export async function createReview(
  input: CreateReviewRequest,
  model: ReviewModel,
  options: CreateReviewOptions = {},
): Promise<CreateReviewResponse> {
  const startedAt = Date.now();
  validateRequest(input);

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
    try {
      rawCandidates = await model.review(article, {
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
      });
    } catch (error) {
      const providerError =
        error instanceof ReviewProviderError
          ? error
          : error instanceof ReviewRequestError
            ? error
            : new ReviewProviderError("Review provider unavailable", error);
      const canDegrade =
        promptMode === "copilot" &&
        getFallbackMode() !== "fail" &&
        ruleHits.length > 0 &&
        !(providerError instanceof ReviewRequestError);
      if (!canDegrade) {
        throw providerError;
      }
      fallback = {
        used: true,
        mode: "rules_only",
        reason: providerError.message,
      };
      rawCandidates = [];
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
          }),
        applicationCache,
      );

  let candidates: ReviewCandidate[] = [];
  try {
    candidates = parseLlmReviewOutput({ candidates: rawCandidates }).candidates;
  } catch (error) {
    const canDegrade =
      promptMode === "copilot" &&
      getFallbackMode() !== "fail" &&
      ruleHits.length > 0;
    if (!canDegrade) {
      throw error;
    }
    fallback = {
      used: true,
      mode: "rules_only",
      reason: error instanceof Error ? error.message : "Provider output failed schema validation",
    };
  }
  const limited = candidates.slice(0, 20);
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
  const fused = promptMode === "baseline" ? llmDrafts : fuseFindings(ruleDrafts, llmDrafts);
  const overridden = applySeverityOverrides(fused);
  const ranked = rankFindings(overridden);
  const findings: Finding[] = ranked.map((item, index) =>
    findingSchema.parse({
      ...item,
      finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
    }),
  );

  const response: CreateReviewResponse = {
    review_id: crypto.randomUUID(),
    article,
    findings,
    pipeline: {
      provider: model.provider,
      model: model.model,
      candidate_count: limited.length,
      located_count: findings.length,
      dropped_count: dropped,
      elapsed_ms: Date.now() - startedAt,
      provenance,
      fallback,
      specialists_enabled: false,
    },
  };

  return createReviewResponseSchema.parse(response);
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
