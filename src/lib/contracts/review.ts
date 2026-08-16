import { z } from "zod";

export const FINDING_TYPES = [
  "basic_text",
  "person",
  "organization",
  "datetime",
  "number",
  "policy",
  "citation",
  "consistency",
  "external_fact",
] as const;

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export const FINDING_STATUSES = ["open"] as const;

export const ARTICLE_FIELDS = ["title", "body"] as const;

export const EVIDENCE_TYPES = [
  "rule",
  "internal_context",
  "retrieved_source",
  "ai_judgment",
] as const;

export const REVIEW_PROVIDERS = ["fixture", "openai"] as const;

export const TITLE_MAX_LENGTH = 500;
export const BODY_MAX_LENGTH = 50_000;

export type FindingType = (typeof FINDING_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type ArticleField = (typeof ARTICLE_FIELDS)[number];
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type ReviewProvider = (typeof REVIEW_PROVIDERS)[number];

export const evidenceItemSchema = z.object({
  label: z.string(),
  text: z.string(),
});

export const evidenceSchema = z.object({
  type: z.enum(EVIDENCE_TYPES),
  summary: z.string(),
  items: z.array(evidenceItemSchema),
});

export const sourceCandidateSchema = z.object({
  field: z.enum(ARTICLE_FIELDS),
  exact_quote: z.string().min(1),
  paragraph_index: z.number().int().nonnegative(),
  context_before: z.string().nullable(),
  context_after: z.string().nullable(),
});

export const reviewCandidateSchema = z.object({
  type: z.enum(FINDING_TYPES),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  reason: z.string().min(1),
  suggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  source: sourceCandidateSchema,
});

export const llmReviewOutputSchema = z.object({
  candidates: z.array(reviewCandidateSchema),
});

export const sourceSpanSchema = z
  .object({
    field: z.enum(ARTICLE_FIELDS),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    quoted_text: z.string().min(1),
    paragraph_index: z.number().int().nonnegative(),
    article_version: z.number().int().positive(),
  })
  .refine((span) => span.end_offset > span.start_offset, {
    message: "end_offset must be greater than start_offset",
  });

export const findingSchema = z.object({
  finding_id: z.string().min(1),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(SEVERITIES),
  source_span: sourceSpanSchema,
  title: z.string().min(1),
  reason: z.string().min(1),
  suggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema,
  status: z.enum(FINDING_STATUSES),
});

export const articleSchema = z.object({
  title: z.string(),
  body: z.string(),
  version: z.number().int().positive(),
});

export const createReviewRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export const pipelineMetadataSchema = z.object({
  provider: z.enum(REVIEW_PROVIDERS),
  model: z.string().nullable(),
  candidate_count: z.number().int().nonnegative(),
  located_count: z.number().int().nonnegative(),
  dropped_count: z.number().int().nonnegative(),
  elapsed_ms: z.number().nonnegative(),
});

export const createReviewResponseSchema = z.object({
  review_id: z.string().min(1),
  article: articleSchema,
  findings: z.array(findingSchema),
  pipeline: pipelineMetadataSchema,
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;
export type LlmReviewOutput = z.infer<typeof llmReviewOutputSchema>;
export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type CanonicalArticle = z.infer<typeof articleSchema>;
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;
export type PipelineMetadata = z.infer<typeof pipelineMetadataSchema>;
export type CreateReviewResponse = z.infer<typeof createReviewResponseSchema>;

export class ReviewRequestError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ReviewRequestError";
  }
}

export class ReviewProviderError extends Error {
  readonly status = 502;

  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ReviewProviderError";
  }
}

export function parseLlmReviewOutput(data: unknown): LlmReviewOutput {
  const parsed = llmReviewOutputSchema.safeParse(data);
  if (!parsed.success) {
    throw new ReviewProviderError("Provider response failed schema validation");
  }
  return parsed.data;
}
