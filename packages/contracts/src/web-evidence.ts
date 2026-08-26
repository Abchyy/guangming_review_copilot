import { z } from "zod";

import type { CanonicalArticle, Finding } from "./review";

export const WEB_EVIDENCE_FACT_CATEGORIES = [
  "person_title",
  "organization_name",
  "policy_regulation",
  "date",
  "number",
  "attribution",
] as const;

export const WEB_EVIDENCE_SOURCE_TIERS = [
  "official",
  "authoritative",
  "secondary",
  "unknown",
] as const;

export const WEB_EVIDENCE_STATUSES = ["retrieved", "unverified"] as const;

export const WEB_EVIDENCE_ERROR_CLASSES = [
  "none",
  "not_found",
  "timeout",
  "provider_failure",
  "policy_rejected",
] as const;

export const WEB_EVIDENCE_PROVIDER_KINDS = ["fake_offline", "live", "unavailable"] as const;

export const WEB_EVIDENCE_UNVERIFIED_MESSAGE = "未能外部核验";
export const WEB_EVIDENCE_RETRIEVED_MESSAGE =
  "已返回可追溯网页证据，仅供审校判断，不构成外部核验结论";

export const WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE = 2;
export const WEB_EVIDENCE_MAX_RESULTS_PER_QUERY = 3;
export const WEB_EVIDENCE_MAX_QUERY_CHARS = 80;

export type WebEvidenceFactCategory = (typeof WEB_EVIDENCE_FACT_CATEGORIES)[number];
export type WebEvidenceSourceTier = (typeof WEB_EVIDENCE_SOURCE_TIERS)[number];
export type WebEvidenceStatus = (typeof WEB_EVIDENCE_STATUSES)[number];
export type WebEvidenceErrorClass = (typeof WEB_EVIDENCE_ERROR_CLASSES)[number];
export type WebEvidenceProviderKind = (typeof WEB_EVIDENCE_PROVIDER_KINDS)[number];

export const webEvidenceCandidateFactSchema = z.object({
  category: z.enum(WEB_EVIDENCE_FACT_CATEGORIES),
  claim: z.string().min(1),
});

export const webEvidenceQuerySchema = z.object({
  query_text: z.string().min(1).max(WEB_EVIDENCE_MAX_QUERY_CHARS),
  fact_category: z.enum(WEB_EVIDENCE_FACT_CATEGORIES),
  allowed_domains: z.array(z.string().min(1)),
  language: z.string().min(1).max(16).optional(),
  region: z.string().min(1).max(16).optional(),
  max_results: z.number().int().min(1).max(WEB_EVIDENCE_MAX_RESULTS_PER_QUERY),
});

export const webEvidenceItemSchema = z.object({
  source_name: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  published_or_version_date: z.string().min(1).nullable(),
  retrieved_at: z.string().min(1),
  source_tier: z.enum(WEB_EVIDENCE_SOURCE_TIERS),
});

export const webEvidenceProvenanceSchema = z
  .object({
    provider_id: z.string().min(1),
    provider_kind: z.enum(WEB_EVIDENCE_PROVIDER_KINDS),
    live_network: z.boolean(),
    retrieved_at: z.string().min(1),
    query_text: z.string(),
    fact_category: z.enum(WEB_EVIDENCE_FACT_CATEGORIES).nullable(),
  })
  .refine(
    (value) =>
      value.provider_kind === "live" || value.live_network === false,
    {
      message: "non-live web evidence providers cannot claim a live network",
    },
  )
  .refine(
    (value) =>
      value.provider_kind !== "fake_offline" || value.live_network === false,
    {
      message: "fake offline web evidence cannot be presented as live retrieval",
    },
  );

export const webEvidenceResultSchema = z
  .object({
    evidence: z.array(webEvidenceItemSchema),
    status: z.enum(WEB_EVIDENCE_STATUSES),
    provenance: webEvidenceProvenanceSchema,
    error_class: z.enum(WEB_EVIDENCE_ERROR_CLASSES),
    message: z.string().min(1),
  })
  .refine(
    (value) =>
      value.status !== "unverified" ||
      value.message === WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    {
      message: "unverified web evidence must use the canonical unverified message",
    },
  )
  .refine(
    (value) => value.status !== "unverified" || value.evidence.length === 0,
    {
      message: "unverified web evidence cannot include retrieved items",
    },
  )
  .refine(
    (value) => value.status !== "unverified" || value.error_class !== "none",
    {
      message: "unverified web evidence must classify the failure safely",
    },
  )
  .refine(
    (value) => value.status !== "retrieved" || value.evidence.length > 0,
    {
      message: "retrieved web evidence must include at least one item",
    },
  )
  .refine(
    (value) => value.status !== "retrieved" || value.error_class === "none",
    {
      message: "retrieved web evidence cannot carry a failure class",
    },
  )
  .refine(
    (value) =>
      value.status !== "retrieved" ||
      value.message === WEB_EVIDENCE_RETRIEVED_MESSAGE,
    {
      message: "retrieved web evidence must use the canonical retrieved message",
    },
  );

export const webEvidenceRunSchema = z.object({
  enabled: z.literal(true),
  query_count: z.number().int().nonnegative(),
  results: z.array(webEvidenceResultSchema),
});

export type WebEvidenceCandidateFact = z.infer<typeof webEvidenceCandidateFactSchema>;
export type WebEvidenceQuery = z.infer<typeof webEvidenceQuerySchema>;
export type WebEvidenceItem = z.infer<typeof webEvidenceItemSchema>;
export type WebEvidenceProvenance = z.infer<typeof webEvidenceProvenanceSchema>;
export type WebEvidenceResult = z.infer<typeof webEvidenceResultSchema>;
export type WebEvidenceRun = z.infer<typeof webEvidenceRunSchema>;

export type WebEvidenceCollectInput = {
  article: CanonicalArticle;
  findings: ReadonlyArray<Pick<Finding, "type" | "title" | "reason" | "source_span">>;
  language?: string;
  region?: string;
  signal?: AbortSignal;
};

export interface WebEvidenceCollector {
  collect(input: WebEvidenceCollectInput): Promise<WebEvidenceRun>;
}

export class WebEvidenceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebEvidenceContractError";
  }
}

export function parseWebEvidenceResult(data: unknown): WebEvidenceResult {
  const parsed = webEvidenceResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new WebEvidenceContractError("Web evidence result failed schema validation");
  }
  return parsed.data;
}

export function parseWebEvidenceRun(data: unknown): WebEvidenceRun {
  const parsed = webEvidenceRunSchema.safeParse(data);
  if (!parsed.success) {
    throw new WebEvidenceContractError("Web evidence run failed schema validation");
  }
  return parsed.data;
}
