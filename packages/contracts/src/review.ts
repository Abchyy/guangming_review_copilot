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

export const FINDING_STATUSES = [
  "pending",
  "accepted",
  "ignored",
  "verify",
  "invalidated",
] as const;

export const UNRESOLVED_STATUSES = ["pending", "verify"] as const;

export const ARTICLE_FIELDS = ["title", "body"] as const;

export const EVIDENCE_KINDS = [
  "rule",
  "internal_context",
  "retrieved_source",
  "ai_judgment",
] as const;

export const REVIEW_PROVIDERS = ["fixture", "deepseek", "openai"] as const;

export const FINDING_ACTIONS = ["accept", "ignore", "verify"] as const;

export const TITLE_MAX_LENGTH = 500;
export const BODY_MAX_LENGTH = 50_000;

export type FindingType = (typeof FINDING_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type UnresolvedStatus = (typeof UNRESOLVED_STATUSES)[number];
export type ArticleField = (typeof ARTICLE_FIELDS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type ReviewProvider = (typeof REVIEW_PROVIDERS)[number];
export type FindingAction = (typeof FINDING_ACTIONS)[number];

export const sourceSpanSchema = z
  .object({
    field: z.enum(ARTICLE_FIELDS),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    quoted_text: z.string(),
    paragraph_index: z.number().int().nonnegative(),
    article_version: z.number().int().positive(),
  })
  .refine((span) => span.end_offset >= span.start_offset, {
    message: "end_offset must be >= start_offset",
  });

export const llmEvidenceItemSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  excerpt: z.string(),
  citation_validated: z.boolean(),
  rule_id: z.string().min(1).optional(),
  source_id: z.string().min(1).optional(),
  source_url: z.string().optional(),
});

export const openaiLlmEvidenceItemSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  excerpt: z.string(),
  citation_validated: z.boolean(),
});

export const evidenceItemSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  excerpt: z.string(),
  citation_validated: z.boolean(),
  rule_id: z.string().optional(),
  source_id: z.string().optional(),
  source_name: z.string().optional(),
  source_url: z.string().optional(),
  source_version_date: z.string().optional(),
  authority_level: z.enum(["official", "internal"]).optional(),
  article_spans: z.array(sourceSpanSchema).optional(),
});

export const suggestionSchema = z.object({
  text: z.string(),
  replacement: z.string().nullable(),
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
  suggestion: suggestionSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(llmEvidenceItemSchema),
  source: sourceCandidateSchema,
  rule_id: z.string().min(1).optional(),
  source_id: z.string().min(1).optional(),
});

export const llmReviewOutputSchema = z.object({
  candidates: z.array(reviewCandidateSchema),
});

export const openaiReviewCandidateSchema = z.object({
  type: z.enum(FINDING_TYPES),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  reason: z.string().min(1),
  suggestion: suggestionSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(openaiLlmEvidenceItemSchema),
  source: sourceCandidateSchema,
});

export const openaiLlmReviewOutputSchema = z.object({
  candidates: z.array(openaiReviewCandidateSchema),
});

export const findingSchema = z.object({
  finding_id: z.string().min(1),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(SEVERITIES),
  source_span: sourceSpanSchema,
  title: z.string().min(1),
  reason: z.string().min(1),
  suggestion: suggestionSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceItemSchema),
  status: z.enum(FINDING_STATUSES),
  requires_verification: z.boolean().optional(),
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

export const cachedTokenStatusSchema = z.enum(["reported", "not_reported", "mixed"]);
export const observationCompletenessSchema = z.enum(["complete", "incomplete", "not_observed"]);
export const observedModelStatusSchema = z.enum(["observed", "not_reported", "inconsistent"]);
export const attemptOutcomeSchema = z.enum(["success", "retryable_failure", "fatal_failure"]);
export const costStatusSchema = z.enum(["determined", "indeterminate", "not_applicable"]);

export const observedUsageSchema = z.object({
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cached_input_tokens: z.number().nullable(),
  cached_input_tokens_status: z.enum(["reported", "not_reported"]),
});

export const providerAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  outcome: attemptOutcomeSchema,
  requested_model: z.string().nullable(),
  observed_response_model: z.string().nullable(),
  received_provider_response: z.boolean(),
  usage: observedUsageSchema.nullable(),
  error: z.string().nullable(),
});

export const aggregatedUsageSchema = z.object({
  input_tokens: z.number().nullable(),
  input_tokens_completeness: observationCompletenessSchema,
  output_tokens: z.number().nullable(),
  output_tokens_completeness: observationCompletenessSchema,
  cached_input_tokens: z.number().nullable(),
  cached_input_tokens_status: cachedTokenStatusSchema,
  cached_input_tokens_completeness: observationCompletenessSchema,
  unobserved_usage_attempts: z.number().int().nonnegative(),
});

export const reviewExecutionProvenanceSchema = z.object({
  adapter_provider: z.enum(REVIEW_PROVIDERS),
  requested_model: z.string().nullable(),
  observed_response_model: z.string().nullable(),
  observed_response_model_status: observedModelStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  attempts: z.array(providerAttemptSchema),
  aggregated_usage: aggregatedUsageSchema,
  application_cache: z.object({
    enabled: z.boolean(),
    hit: z.boolean(),
  }),
  latency_ms: z.number().nonnegative(),
});

export const pipelineFallbackSchema = z.object({
  used: z.boolean(),
  mode: z.enum(["none", "rules_only"]),
  reason: z.string().nullable(),
});

export const pipelineMetadataSchema = z.object({
  provider: z.enum(REVIEW_PROVIDERS),
  model: z.string().nullable(),
  candidate_count: z.number().int().nonnegative(),
  located_count: z.number().int().nonnegative(),
  dropped_count: z.number().int().nonnegative(),
  elapsed_ms: z.number().nonnegative(),
  provenance: reviewExecutionProvenanceSchema.optional(),
  fallback: pipelineFallbackSchema.optional(),
  specialists_enabled: z.boolean().optional(),
});

export const createReviewResponseSchema = z.object({
  review_id: z.string().min(1),
  article: articleSchema,
  findings: z.array(findingSchema),
  pipeline: pipelineMetadataSchema,
});

export const findingDecisionRequestSchema = z.object({
  action: z.enum(FINDING_ACTIONS),
  expected_article_version: z.number().int().positive(),
  action_id: z.string().min(1),
});

export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type LlmEvidenceItem = z.infer<typeof llmEvidenceItemSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;
export type LlmReviewOutput = z.infer<typeof llmReviewOutputSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type CanonicalArticle = z.infer<typeof articleSchema>;
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;
export type ObservedUsage = z.infer<typeof observedUsageSchema>;
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;
export type AggregatedUsage = z.infer<typeof aggregatedUsageSchema>;
export type ReviewExecutionProvenance = z.infer<typeof reviewExecutionProvenanceSchema>;
export type CachedTokenStatus = z.infer<typeof cachedTokenStatusSchema>;
export type ObservationCompleteness = z.infer<typeof observationCompletenessSchema>;
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
export type CostStatus = z.infer<typeof costStatusSchema>;
export type PipelineMetadata = z.infer<typeof pipelineMetadataSchema>;
export type CreateReviewResponse = z.infer<typeof createReviewResponseSchema>;
export type FindingDecisionRequest = z.infer<typeof findingDecisionRequestSchema>;

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

export class ReviewDomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReviewDomainError";
  }
}

export function parseLlmReviewOutput(data: unknown): LlmReviewOutput {
  const parsed = llmReviewOutputSchema.safeParse(data);
  if (!parsed.success) {
    throw new ReviewProviderError("Provider response failed schema validation");
  }
  return parsed.data;
}

export function isUnresolvedStatus(status: FindingStatus): boolean {
  return status === "pending" || status === "verify";
}
