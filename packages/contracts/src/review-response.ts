import { z } from "zod";

import {
  REVIEW_PROVIDERS,
  articleSchema,
  findingSchema,
  pipelineFallbackSchema,
  reviewExecutionProvenanceSchema,
} from "./review";
import { specialistOrchestrationRunSchema } from "./specialists";
import { webEvidenceRunSchema } from "./web-evidence";

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
  specialist_orchestration: specialistOrchestrationRunSchema.optional(),
  web_evidence: webEvidenceRunSchema.optional(),
});

export const createReviewResponseSchema = z.object({
  review_id: z.string().min(1),
  article: articleSchema,
  findings: z.array(findingSchema),
  pipeline: pipelineMetadataSchema,
});

export type PipelineMetadata = z.infer<typeof pipelineMetadataSchema>;
export type CreateReviewResponse = z.infer<typeof createReviewResponseSchema>;
