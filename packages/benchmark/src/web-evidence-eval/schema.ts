import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const WEB_EVIDENCE_DEV_PROTOCOL_ID = "web-evidence-dev-eval";
export const WEB_EVIDENCE_DEV_PROTOCOL_VERSION = "0.1.0";

export const RISK_CATEGORIES = [
  "person_title",
  "organization_name",
  "policy_regulation",
  "date",
  "number",
  "attribution",
] as const;

export const EXPECTED_STATUSES = [
  "confirmed",
  "conflicting",
  "insufficient",
  "not_applicable",
] as const;

export const ALLOWED_SOURCE_CLASSES = [
  "official_agency_page",
  "official_gazette",
  "statute_or_regulation",
  "statistical_bulletin",
  "authorized_news_release",
  "calendar_authority",
] as const;

export const FORBIDDEN_OUTBOUND_FIELDS = [
  "full_unpublished_body",
  "reporter_phone",
  "reporter_email",
  "private_citizen_address",
  "private_citizen_id",
  "unpublished_source_identity",
  "internal_newsroom_note",
  "holdout_identifier",
  "draft_watermark",
  "interviewee_contact",
] as const;

export const FAILURE_KINDS = [
  "timeout",
  "provider_error",
  "no_allowed_source",
  "empty_result",
] as const;

export const GATE_METRIC_IDS = [
  "query_trigger_accuracy",
  "query_budget_compliance_rate",
  "authoritative_source_ratio",
  "evidence_traceability_rate",
  "failure_degradation_correctness",
  "privacy_minimization_compliance_rate",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export type ExpectedStatus = (typeof EXPECTED_STATUSES)[number];
export type AllowedSourceClass = (typeof ALLOWED_SOURCE_CLASSES)[number];
export type ForbiddenOutboundField = (typeof FORBIDDEN_OUTBOUND_FIELDS)[number];
export type FailureKind = (typeof FAILURE_KINDS)[number];
export type GateMetricId = (typeof GATE_METRIC_IDS)[number];

const fixtureSourceSchema = z.object({
  source_class: z.string().min(1),
  title: z.string().min(1),
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  as_of: z.string().min(1),
});

const gateSchema = z.object({
  operator: z.enum(["gte", "eq"]),
  threshold: z.number().min(0).max(1),
  hardness: z.enum(["hard", "soft"]),
});

export const webEvidenceDevCaseSchema = z
  .object({
    case_id: z.string().regex(/^we-dev-[0-9]{3}-[a-z0-9-]+$/),
    article_id: z.string().regex(/^we-dev-art-[a-z0-9-]+$/),
    risk_category: z.enum(RISK_CATEGORIES),
    as_of: z.string().min(1),
    article_excerpt: z.string().min(1),
    claim: z.object({
      text: z.string().min(1),
      span_quote: z.string().min(1),
      normalized_fact: z.string().min(1),
    }),
    should_trigger_query: z.boolean(),
    query_priority: z.number().int().positive(),
    allowed_source_classes: z.array(z.enum(ALLOWED_SOURCE_CLASSES)),
    expected_status: z.enum(EXPECTED_STATUSES),
    expected_failure: z.enum(FAILURE_KINDS).nullable(),
    forbidden_outbound_fields: z.array(z.enum(FORBIDDEN_OUTBOUND_FIELDS)).min(1),
    sensitive_context: z.record(z.string(), z.string()),
    fixture_sources: z.array(fixtureSourceSchema),
    adjudication_hint: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (!value.should_trigger_query && value.expected_status !== "not_applicable") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: skip cases must use expected_status not_applicable`,
      });
    }
    if (!value.should_trigger_query && value.allowed_source_classes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: skip cases must not list allowed sources`,
      });
    }
    if (value.should_trigger_query && value.expected_status === "not_applicable") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: trigger cases cannot use not_applicable`,
      });
    }
    if (value.should_trigger_query && value.allowed_source_classes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: trigger cases must list allowed source classes`,
      });
    }
    if (value.expected_failure && value.expected_status !== "insufficient") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: expected_failure requires insufficient`,
      });
    }
    if (!value.article_excerpt.includes(value.claim.span_quote)) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: span_quote must occur in article_excerpt`,
      });
    }
  });

export const webEvidenceDevDatasetSchema = z
  .object({
    protocol_id: z.literal(WEB_EVIDENCE_DEV_PROTOCOL_ID),
    protocol_version: z.string().min(1),
    dataset_version: z.string().min(1),
    role: z.literal("development_only"),
    split: z.literal("dev"),
    official_holdout: z.literal(false),
    may_claim_official_locked_generalization: z.literal(false),
    provenance: z.object({
      authoring: z.literal("handwritten_synthetic"),
      contains_unpublished_real_articles: z.literal(false),
      contains_real_pii: z.literal(false),
      contains_holdout_gold: z.literal(false),
      network_required_to_score: z.literal(false),
    }),
    query_budget: z.object({
      max_queries_per_article: z.number().int().positive(),
      max_queries_per_claim: z.number().int().positive(),
      max_results_per_query: z.number().int().positive(),
    }),
    gates: z.object({
      query_trigger_accuracy: gateSchema,
      query_budget_compliance_rate: gateSchema,
      authoritative_source_ratio: gateSchema,
      evidence_traceability_rate: gateSchema,
      failure_degradation_correctness: gateSchema,
      privacy_minimization_compliance_rate: gateSchema,
    }),
    enumerations: z.object({
      risk_categories: z.tuple([
        z.literal("person_title"),
        z.literal("organization_name"),
        z.literal("policy_regulation"),
        z.literal("date"),
        z.literal("number"),
        z.literal("attribution"),
      ]),
      expected_statuses: z.tuple([
        z.literal("confirmed"),
        z.literal("conflicting"),
        z.literal("insufficient"),
        z.literal("not_applicable"),
      ]),
      allowed_source_classes: z.array(z.enum(ALLOWED_SOURCE_CLASSES)).min(1),
      forbidden_outbound_fields: z.array(z.enum(FORBIDDEN_OUTBOUND_FIELDS)).min(1),
    }),
    cases: z.array(webEvidenceDevCaseSchema).min(1),
  })
  .superRefine((dataset, ctx) => {
    const ids = new Set<string>();
    for (const item of dataset.cases) {
      if (ids.has(item.case_id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate case_id: ${item.case_id}`,
        });
      }
      ids.add(item.case_id);
    }
    for (const category of RISK_CATEGORIES) {
      if (!dataset.cases.some((item) => item.risk_category === category)) {
        ctx.addIssue({
          code: "custom",
          message: `missing risk category coverage: ${category}`,
        });
      }
    }
    for (const status of EXPECTED_STATUSES) {
      if (!dataset.cases.some((item) => item.expected_status === status)) {
        ctx.addIssue({
          code: "custom",
          message: `missing expected_status coverage: ${status}`,
        });
      }
    }
  });

export const webEvidenceDevTraceSourceSchema = z.object({
  source_class: z.string().min(1),
  locator: z.string(),
  excerpt: z.string(),
});

export const webEvidenceDevTraceSchema = z
  .object({
    case_id: z.string().min(1),
    triggered: z.boolean(),
    query_count: z.number().int().nonnegative(),
    query_text: z.string().nullable(),
    outbound_fields: z.array(z.string()),
    outbound_text_blobs: z.array(z.string()),
    sources: z.array(webEvidenceDevTraceSourceSchema),
    status: z.enum(EXPECTED_STATUSES),
    failure: z
      .object({
        kind: z.enum(FAILURE_KINDS),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (!value.triggered && value.query_count !== 0) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: untriggered traces must have query_count 0`,
      });
    }
    if (value.triggered && value.query_count < 1) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: triggered traces must have query_count >= 1`,
      });
    }
  });

export type WebEvidenceDevCase = z.infer<typeof webEvidenceDevCaseSchema>;
export type WebEvidenceDevDataset = z.infer<typeof webEvidenceDevDatasetSchema>;
export type WebEvidenceDevTrace = z.infer<typeof webEvidenceDevTraceSchema>;
export type WebEvidenceDevTraceSource = z.infer<typeof webEvidenceDevTraceSourceSchema>;

const DATASET_PATH = join(dirname(fileURLToPath(import.meta.url)), "dataset.json");

export function webEvidenceDevDatasetPath(): string {
  return DATASET_PATH;
}

export function loadWebEvidenceDevDataset(
  filePath: string = DATASET_PATH,
): WebEvidenceDevDataset {
  const parsed = webEvidenceDevDatasetSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  if (parsed.official_holdout || parsed.split === ("locked" as string)) {
    throw new Error("Web Evidence dev dataset must not claim official holdout or locked split");
  }
  return parsed;
}

export function summarizeWebEvidenceDevCoverage(dataset: WebEvidenceDevDataset): {
  case_count: number;
  article_count: number;
  risk_categories: RiskCategory[];
  expected_statuses: ExpectedStatus[];
  trigger_true: number;
  trigger_false: number;
  expected_failures: number;
} {
  return {
    case_count: dataset.cases.length,
    article_count: new Set(dataset.cases.map((item) => item.article_id)).size,
    risk_categories: RISK_CATEGORIES.filter((category) =>
      dataset.cases.some((item) => item.risk_category === category),
    ),
    expected_statuses: EXPECTED_STATUSES.filter((status) =>
      dataset.cases.some((item) => item.expected_status === status),
    ),
    trigger_true: dataset.cases.filter((item) => item.should_trigger_query).length,
    trigger_false: dataset.cases.filter((item) => !item.should_trigger_query).length,
    expected_failures: dataset.cases.filter((item) => item.expected_failure != null).length,
  };
}
