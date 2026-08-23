import { z } from "zod";

import {
  REVIEW_PROVIDERS,
  articleSchema,
  reviewCandidateSchema,
  sourceSpanSchema,
} from "./review";

export const SPECIALIST_IDS = ["entity", "policy", "numeric", "citation"] as const;

export const SPECIALIST_EXECUTION_STATUSES = [
  "not_invoked",
  "succeeded",
  "failed",
  "timed_out",
] as const;

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

export const specialistTaskSchema = z.object({
  taskId: z.string().min(1),
  specialist: z.enum(SPECIALIST_IDS),
  article: articleSchema,
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

export type SpecialistId = (typeof SPECIALIST_IDS)[number];
export type SpecialistExecutionStatus = (typeof SPECIALIST_EXECUTION_STATUSES)[number];
export type SpecialistRetrievedEvidence = z.infer<typeof specialistRetrievedEvidenceSchema>;
export type SpecialistTask = z.infer<typeof specialistTaskSchema>;
export type SpecialistResult = z.infer<typeof specialistResultSchema>;
export type AgentExecutionProvenance = z.infer<typeof agentExecutionProvenanceSchema>;

export interface Specialist {
  readonly id: SpecialistId;
  run(task: SpecialistTask): Promise<SpecialistResult>;
}
