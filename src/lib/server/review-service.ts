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
} from "@/lib/contracts/review";
import { canonicalizeArticle } from "@/lib/server/normalization";
import type { ReviewModel, ReviewPromptMode } from "@/lib/server/llm/review-model";
import { LlmCandidateCache } from "@/lib/server/llm/candidate-cache";
import {
  attachApplicationCache,
  fallbackProvenance,
} from "@/lib/server/llm/provenance";
import { PROMPT_VERSION, OUTPUT_SCHEMA_VERSION } from "@/lib/server/llm/prompt";
import { getReviewDatabase } from "@/lib/server/db";
import {
  fieldText,
  locateSourceSpan,
  assertSliceEqualsQuotedText,
} from "@/lib/server/span-locator";
import { buildCandidateCacheKey, hashCanonicalArticle } from "@/lib/server/quality/article-hash";
import { getCorpusVersion } from "@/lib/server/quality/corpus";
import { materializeLlmEvidence, ruleHitToFindingDraft } from "@/lib/server/quality/evidence";
import { fuseFindings, type DraftFinding } from "@/lib/server/quality/fusion";
import { rankFindings } from "@/lib/server/quality/ranking";
import { retrieveCorpus } from "@/lib/server/quality/retrieval";
import { getRuleVersion, runRules } from "@/lib/server/quality/rules";
import { applySeverityOverrides } from "@/lib/server/quality/severity";

export type CreateReviewOptions = {
  promptMode?: ReviewPromptMode;
  useCache?: boolean;
  cache?: LlmCandidateCache | null;
  disableRules?: boolean;
  disableRetrieval?: boolean;
};

function defaultCache(): LlmCandidateCache {
  return new LlmCandidateCache(getReviewDatabase());
}

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
  const cache = shouldCache ? (options.cache ?? defaultCache()) : null;
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
      if (error instanceof ReviewProviderError || error instanceof ReviewRequestError) {
        throw error;
      }
      throw new ReviewProviderError("Review provider unavailable", error);
    }
    if (cache && Array.isArray(rawCandidates)) {
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

  const { candidates } = parseLlmReviewOutput({ candidates: rawCandidates });
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
