import { z } from "zod";

import {
  ARTICLE_FIELDS,
  FINDING_STATUSES,
  FINDING_TYPES,
  REVIEW_PROVIDERS,
  SEVERITIES,
  articleSchema,
  reviewCandidateSchema,
  sourceSpanSchema,
  suggestionSchema,
} from "./review";

export const SPECIALIST_IDS = [
  "entity",
  "policy",
  "numeric",
  "citation",
  "fact_check",
  "news_edit",
] as const;

/** Model-backed review roles. The rules engine is not a specialist. */
export const MODEL_SPECIALIST_IDS = ["fact_check", "news_edit"] as const;

export const SPECIALIST_EXECUTION_STATUSES = [
  "not_invoked",
  "succeeded",
  "failed",
  "timed_out",
] as const;

export const SPECIALIST_JUDGMENT_DECISIONS = ["keep", "verify"] as const;

export const SPECIALIST_MAX_PER_ARTICLE = 2;

export const specialistRetrievedEvidenceSchema = z.object({
  source_id: z.string().min(1),
  source_name: z.string().min(1),
  source_url: z.string().min(1),
  authority_level: z.enum(["official", "internal"]),
  published_at: z.string(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  excerpt: z.string().min(1),
  match_rank: z.number(),
  trigger: z.string().min(1),
});

export const specialistFragmentSchema = z.object({
  field: z.enum(ARTICLE_FIELDS),
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().nonnegative(),
  quoted_text: z.string().min(1),
  paragraph_index: z.number().int().nonnegative(),
  article_version: z.number().int().positive(),
  context_before: z.string().nullable(),
  context_after: z.string().nullable(),
});

export const specialistPreliminaryFindingSchema = z.object({
  finding_id: z.string().min(1).optional(),
  type: z.enum(FINDING_TYPES),
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  reason: z.string().min(1),
  source_span: sourceSpanSchema,
  suggestion: suggestionSchema.optional(),
  confidence: z.number().min(0).max(1),
  status: z.enum(FINDING_STATUSES).optional(),
  requires_verification: z.boolean().optional(),
});

export const specialistTaskSchema = z.object({
  taskId: z.string().min(1),
  specialist: z.enum(SPECIALIST_IDS),
  article: articleSchema.optional(),
  fragments: z.array(specialistFragmentSchema).default([]),
  preliminaryFindings: z.array(specialistPreliminaryFindingSchema).default([]),
  candidateSpans: z.array(sourceSpanSchema),
  retrievedEvidence: z.array(specialistRetrievedEvidenceSchema),
  constraints: z.object({
    maxCandidates: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    allowExternalRetrieval: z.boolean(),
  }),
});

export const agentExecutionProvenanceSchema = z.object({
  taskId: z.string().min(1),
  specialist: z.enum(SPECIALIST_IDS),
  invoked: z.boolean(),
  status: z.enum(SPECIALIST_EXECUTION_STATUSES),
  provider: z.enum(REVIEW_PROVIDERS).nullable(),
  model: z.string().nullable(),
  elapsedMs: z.number().nonnegative(),
});

export const specialistResultSchema = z.object({
  taskId: z.string().min(1),
  candidates: z.array(reviewCandidateSchema),
  provenance: agentExecutionProvenanceSchema,
  warnings: z.array(z.string()),
});

export const specialistSkipSchema = z.object({
  specialist: z.enum(SPECIALIST_IDS),
  reason: z.string().min(1),
});

export const specialistJudgmentSchema = z.object({
  field: z.enum(ARTICLE_FIELDS),
  paragraph_index: z.number().int().nonnegative(),
  quoted_text: z.string().min(1),
  decision: z.enum(SPECIALIST_JUDGMENT_DECISIONS),
  reason: z.string().min(1),
  specialist_ids: z.array(z.enum(SPECIALIST_IDS)).min(1),
  requires_verification: z.boolean(),
});

export const specialistOrchestrationBudgetSchema = z.object({
  max_specialists: z.number().int().positive(),
  used: z.number().int().nonnegative(),
});

export const specialistOrchestrationRunSchema = z.object({
  enabled: z.literal(true),
  target_model: z.string().min(1),
  dispatched: z.array(z.enum(SPECIALIST_IDS)),
  skipped: z.array(specialistSkipSchema),
  budget: specialistOrchestrationBudgetSchema,
  results: z.array(specialistResultSchema),
  judgments: z.array(specialistJudgmentSchema),
  warnings: z.array(z.string()),
});

export type SpecialistId = (typeof SPECIALIST_IDS)[number];
export type ModelSpecialistId = (typeof MODEL_SPECIALIST_IDS)[number];
export type SpecialistExecutionStatus = (typeof SPECIALIST_EXECUTION_STATUSES)[number];
export type SpecialistJudgmentDecision = (typeof SPECIALIST_JUDGMENT_DECISIONS)[number];
export type SpecialistRetrievedEvidence = z.infer<typeof specialistRetrievedEvidenceSchema>;
export type SpecialistFragment = z.infer<typeof specialistFragmentSchema>;
export type SpecialistPreliminaryFinding = z.infer<typeof specialistPreliminaryFindingSchema>;
export type SpecialistTask = z.infer<typeof specialistTaskSchema>;
export type SpecialistResult = z.infer<typeof specialistResultSchema>;
export type AgentExecutionProvenance = z.infer<typeof agentExecutionProvenanceSchema>;
export type SpecialistSkip = z.infer<typeof specialistSkipSchema>;
export type SpecialistJudgment = z.infer<typeof specialistJudgmentSchema>;
export type SpecialistOrchestrationBudget = z.infer<typeof specialistOrchestrationBudgetSchema>;
export type SpecialistOrchestrationRun = z.infer<typeof specialistOrchestrationRunSchema>;

export interface Specialist {
  readonly id: SpecialistId;
  run(task: SpecialistTask): Promise<SpecialistResult>;
}

export class SpecialistContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecialistContractError";
  }
}

export function parseSpecialistTask(data: unknown): SpecialistTask {
  const parsed = specialistTaskSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpecialistContractError("Specialist task failed schema validation");
  }
  return parsed.data;
}

export function parseSpecialistResult(data: unknown): SpecialistResult {
  const parsed = specialistResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpecialistContractError("Specialist result failed schema validation");
  }
  return parsed.data;
}

export function parseSpecialistOrchestrationRun(data: unknown): SpecialistOrchestrationRun {
  const parsed = specialistOrchestrationRunSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpecialistContractError("Specialist orchestration run failed schema validation");
  }
  return parsed.data;
}
