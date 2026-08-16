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
} from "@/lib/contracts/review";
import { canonicalizeArticle } from "@/lib/server/normalization";
import type { ReviewModel } from "@/lib/server/llm/review-model";
import {
  fieldText,
  locateSourceSpan,
  assertSliceEqualsQuotedText,
} from "@/lib/server/span-locator";

export async function createReview(
  input: CreateReviewRequest,
  model: ReviewModel,
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

  let rawCandidates: unknown;
  try {
    rawCandidates = await model.review(article);
  } catch (error) {
    if (error instanceof ReviewProviderError || error instanceof ReviewRequestError) {
      throw error;
    }
    throw new ReviewProviderError("Review provider unavailable", error);
  }

  const { candidates } = parseLlmReviewOutput({ candidates: rawCandidates });
  const findings: Finding[] = [];

  for (const candidate of candidates) {
    const span = locateSourceSpan(article, candidate.source);
    if (!span) {
      continue;
    }

    const text = fieldText(article, span.field);
    assertSliceEqualsQuotedText(text, span);

    const finding = findingSchema.parse({
      finding_id: `finding-${String(findings.length + 1).padStart(3, "0")}`,
      type: candidate.type,
      severity: candidate.severity,
      source_span: span,
      title: candidate.title,
      reason: candidate.reason,
      suggestion: candidate.suggestion,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      status: "open",
    });
    findings.push(finding);
  }

  const response: CreateReviewResponse = {
    review_id: crypto.randomUUID(),
    article,
    findings,
    pipeline: {
      provider: model.provider,
      model: model.model,
      candidate_count: candidates.length,
      located_count: findings.length,
      dropped_count: candidates.length - findings.length,
      elapsed_ms: Date.now() - startedAt,
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
