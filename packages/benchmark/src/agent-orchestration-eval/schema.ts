import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const AGENT_ORCHESTRATION_DEV_PROTOCOL_ID = "agent-orchestration-dev-eval";
export const AGENT_ORCHESTRATION_DEV_PROTOCOL_VERSION = "0.3.0";

export const SPECIALIST_IDS = ["fact_check", "news_edit"] as const;

export const REVIEW_DIMENSIONS = ["entity", "policy", "numeric", "citation"] as const;

export const EXECUTION_STATUSES = [
  "not_invoked",
  "succeeded",
  "failed",
  "timed_out",
] as const;

export const TRIGGER_KINDS = [
  "entity",
  "policy",
  "numeric",
  "citation",
  "wording",
  "consistency",
  "basic_text",
  "none",
] as const;

export const NEWS_EDIT_TRIGGER_KINDS = ["wording", "consistency"] as const;

export const RULES_ENGINE_TRIGGER_KINDS = ["basic_text"] as const;

export const AGENT_ORCHESTRATION_FAILURE_KINDS = [
  "timeout",
  "provider_error",
  "empty_evidence",
] as const;

export const AUTHORITY_LEVELS = ["official", "internal"] as const;

export const AGENT_ORCHESTRATION_GATE_METRIC_IDS = [
  "dispatch_accuracy",
  "parallel_budget_compliance_rate",
  "failure_degradation_correctness",
  "result_traceability_rate",
  "duplicate_suppression_rate",
  "extra_model_cost_compliance_rate",
] as const;

export type SpecialistId = (typeof SPECIALIST_IDS)[number];
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export type AgentOrchestrationFailureKind = (typeof AGENT_ORCHESTRATION_FAILURE_KINDS)[number];
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];
export type AgentOrchestrationGateMetricId = (typeof AGENT_ORCHESTRATION_GATE_METRIC_IDS)[number];

const gateSchema = z.object({
  operator: z.enum(["gte", "eq"]),
  threshold: z.number().min(0).max(1),
  hardness: z.enum(["hard", "soft"]),
});

const fixtureEvidenceSchema = z.object({
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  authority_level: z.enum(AUTHORITY_LEVELS),
});

function specialistMatchesTrigger(specialist: SpecialistId, triggerKind: TriggerKind): boolean {
  if (triggerKind === "none" || triggerKind === "basic_text") {
    return true;
  }
  if (specialist === "fact_check") {
    return (REVIEW_DIMENSIONS as readonly string[]).includes(triggerKind);
  }
  return (NEWS_EDIT_TRIGGER_KINDS as readonly string[]).includes(triggerKind);
}

export const agentOrchestrationDevCaseSchema = z
  .object({
    case_id: z.string().regex(/^ao-dev-[0-9]{3}-[a-z0-9-]+$/),
    article_id: z.string().regex(/^ao-dev-art-[a-z0-9-]+$/),
    specialist: z.enum(SPECIALIST_IDS),
    trigger_kind: z.enum(TRIGGER_KINDS),
    as_of: z.string().min(1),
    article_excerpt: z.string().min(1),
    candidate_span: z.object({
      text: z.string().min(1),
      span_quote: z.string().min(1),
    }),
    should_dispatch: z.boolean(),
    dispatch_priority: z.number().int().positive(),
    expected_status: z.enum(EXECUTION_STATUSES),
    expected_failure: z.enum(AGENT_ORCHESTRATION_FAILURE_KINDS).nullable(),
    duplicate_of: z.string().min(1).nullable(),
    expected_enters_findings: z.boolean(),
    fixture_evidence: z.array(fixtureEvidenceSchema),
    adjudication_hint: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (!specialistMatchesTrigger(value.specialist, value.trigger_kind)) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: specialist ${value.specialist} does not match trigger_kind ${value.trigger_kind}`,
      });
    }
    if (value.trigger_kind === "basic_text" && value.should_dispatch) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: basic_text belongs to the rules engine and must not dispatch a specialist`,
      });
    }
    if (value.trigger_kind === "basic_text" && value.expected_failure) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: basic_text cannot be a specialist failure fixture`,
      });
    }
    if (
      value.specialist === "news_edit" &&
      value.should_dispatch &&
      !(NEWS_EDIT_TRIGGER_KINDS as readonly string[]).includes(value.trigger_kind)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: news_edit dispatch requires wording or consistency`,
      });
    }
    if (!value.should_dispatch && value.expected_status !== "not_invoked") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: skip/suppress cases must use expected_status not_invoked`,
      });
    }
    if (value.should_dispatch && value.expected_status === "not_invoked") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: dispatch cases cannot use not_invoked`,
      });
    }
    if (!value.should_dispatch && value.expected_enters_findings) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: skip/suppress cases cannot enter findings`,
      });
    }
    if (value.duplicate_of && value.should_dispatch) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: duplicate cases must not independently dispatch`,
      });
    }
    if (value.duplicate_of === value.case_id) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: duplicate_of cannot point to itself`,
      });
    }
    if (value.expected_failure && value.expected_enters_findings) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: expected_failure cannot enter findings`,
      });
    }
    if (value.expected_failure === "timeout" && value.expected_status !== "timed_out") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: timeout requires expected_status timed_out`,
      });
    }
    if (value.expected_failure === "provider_error" && value.expected_status !== "failed") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: provider_error requires expected_status failed`,
      });
    }
    if (value.expected_failure && !value.should_dispatch) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: expected_failure requires a dispatch attempt`,
      });
    }
    if (!value.article_excerpt.includes(value.candidate_span.span_quote)) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: span_quote must occur in article_excerpt`,
      });
    }
  });

export const agentOrchestrationDevDatasetSchema = z
  .object({
    protocol_id: z.literal(AGENT_ORCHESTRATION_DEV_PROTOCOL_ID),
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
    orchestration_budget: z.object({
      max_specialists_per_article: z.number().int().positive(),
      max_parallel_invocations: z.number().int().positive(),
      max_extra_model_calls_per_article: z.number().int().positive(),
      max_extra_tokens_per_article: z.number().int().positive(),
      specialist_deadline_ms: z.number().int().positive(),
    }),
    gates: z.object({
      dispatch_accuracy: gateSchema,
      parallel_budget_compliance_rate: gateSchema,
      failure_degradation_correctness: gateSchema,
      result_traceability_rate: gateSchema,
      duplicate_suppression_rate: gateSchema,
      extra_model_cost_compliance_rate: gateSchema,
    }),
    enumerations: z.object({
      specialist_ids: z.tuple([z.literal("fact_check"), z.literal("news_edit")]),
      review_dimensions: z.tuple([
        z.literal("entity"),
        z.literal("policy"),
        z.literal("numeric"),
        z.literal("citation"),
      ]),
      execution_statuses: z.tuple([
        z.literal("not_invoked"),
        z.literal("succeeded"),
        z.literal("failed"),
        z.literal("timed_out"),
      ]),
      trigger_kinds: z.tuple([
        z.literal("entity"),
        z.literal("policy"),
        z.literal("numeric"),
        z.literal("citation"),
        z.literal("wording"),
        z.literal("consistency"),
        z.literal("basic_text"),
        z.literal("none"),
      ]),
      failure_kinds: z.tuple([
        z.literal("timeout"),
        z.literal("provider_error"),
        z.literal("empty_evidence"),
      ]),
    }),
    cases: z.array(agentOrchestrationDevCaseSchema).min(1),
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
    for (const item of dataset.cases) {
      if (item.duplicate_of && !ids.has(item.duplicate_of)) {
        ctx.addIssue({
          code: "custom",
          message: `${item.case_id}: duplicate_of ${item.duplicate_of} does not exist`,
        });
      }
      if (item.duplicate_of) {
        const canonical = dataset.cases.find((row) => row.case_id === item.duplicate_of);
        if (
          canonical &&
          (canonical.article_id !== item.article_id || canonical.specialist !== item.specialist)
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${item.case_id}: duplicate must share article_id and specialist with canonical`,
          });
        }
      }
    }
    for (const item of dataset.cases) {
      if ((REVIEW_DIMENSIONS as readonly string[]).includes(item.specialist)) {
        ctx.addIssue({
          code: "custom",
          message: `${item.case_id}: ${item.specialist} is a review dimension, not a specialist`,
        });
      }
    }
    for (const specialist of SPECIALIST_IDS) {
      const rows = dataset.cases.filter((item) => item.specialist === specialist);
      if (!rows.some((item) => item.should_dispatch)) {
        ctx.addIssue({
          code: "custom",
          message: `missing dispatch coverage for specialist: ${specialist}`,
        });
      }
      if (!rows.some((item) => !item.should_dispatch)) {
        ctx.addIssue({
          code: "custom",
          message: `missing skip coverage for specialist: ${specialist}`,
        });
      }
    }
    for (const dimension of REVIEW_DIMENSIONS) {
      if (!dataset.cases.some((item) => item.trigger_kind === dimension)) {
        ctx.addIssue({
          code: "custom",
          message: `missing review-dimension trigger coverage: ${dimension}`,
        });
      }
    }
    if (
      !dataset.cases.some(
        (item) =>
          item.specialist === "news_edit" &&
          item.trigger_kind === "consistency" &&
          item.should_dispatch,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include a news_edit consistency dispatch case",
      });
    }
    if (
      !dataset.cases.some(
        (item) =>
          item.trigger_kind === "basic_text" &&
          !item.should_dispatch &&
          item.specialist === "news_edit",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include a basic_text skip that does not dispatch news_edit",
      });
    }
    for (const item of dataset.cases) {
      if (
        item.specialist === "news_edit" &&
        (item.should_dispatch || item.expected_failure != null) &&
        item.trigger_kind === "basic_text"
      ) {
        ctx.addIssue({
          code: "custom",
          message: `${item.case_id}: news_edit success/failure fixtures cannot use basic_text`,
        });
      }
    }
    for (const status of EXECUTION_STATUSES) {
      if (!dataset.cases.some((item) => item.expected_status === status)) {
        ctx.addIssue({
          code: "custom",
          message: `missing expected_status coverage: ${status}`,
        });
      }
    }
    if (!dataset.cases.some((item) => item.duplicate_of != null)) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include at least one duplicate suppression case",
      });
    }
    if (!dataset.cases.some((item) => item.expected_failure === "timeout")) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include a timeout degradation case",
      });
    }
    if (!dataset.cases.some((item) => item.expected_failure === "provider_error")) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include a provider_error degradation case",
      });
    }
    const dispatchByArticle = new Map<string, number>();
    for (const item of dataset.cases) {
      if (item.should_dispatch) {
        dispatchByArticle.set(item.article_id, (dispatchByArticle.get(item.article_id) ?? 0) + 1);
      }
    }
    for (const item of dataset.cases) {
      const articleDispatchCount = dispatchByArticle.get(item.article_id) ?? 0;
      if (
        item.specialist === "news_edit" &&
        articleDispatchCount > dataset.orchestration_budget.max_specialists_per_article &&
        item.trigger_kind === "basic_text"
      ) {
        ctx.addIssue({
          code: "custom",
          message: `${item.case_id}: budget fixtures cannot use basic_text for news_edit`,
        });
      }
    }
    const hasBudgetOverflow = [...dispatchByArticle.values()].some(
      (count) => count > dataset.orchestration_budget.max_specialists_per_article,
    );
    if (!hasBudgetOverflow) {
      ctx.addIssue({
        code: "custom",
        message: "dataset must include an article that exceeds specialist budget",
      });
    }
  });

export const agentOrchestrationDevTraceSchema = z
  .object({
    case_id: z.string().min(1),
    dispatched: z.boolean(),
    specialist: z.enum(SPECIALIST_IDS),
    status: z.enum(EXECUTION_STATUSES),
    task_id: z.string(),
    elapsed_ms: z.number().nonnegative(),
    observed_parallel: z.number().int().nonnegative(),
    extra_model_calls: z.number().int().nonnegative(),
    extra_tokens: z.number().int().nonnegative(),
    result_locator: z.string(),
    result_excerpt: z.string(),
    entered_findings: z.boolean(),
    suppressed_as_duplicate: z.boolean(),
    failure: z
      .object({
        kind: z.enum(AGENT_ORCHESTRATION_FAILURE_KINDS),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (!value.dispatched) {
      if (value.status !== "not_invoked") {
        ctx.addIssue({
          code: "custom",
          message: `${value.case_id}: undispatched traces must use status not_invoked`,
        });
      }
      if (value.entered_findings) {
        ctx.addIssue({
          code: "custom",
          message: `${value.case_id}: undispatched traces cannot enter findings`,
        });
      }
      if (value.extra_model_calls !== 0 || value.extra_tokens !== 0) {
        ctx.addIssue({
          code: "custom",
          message: `${value.case_id}: undispatched traces must not incur extra model cost`,
        });
      }
    }
    if (value.dispatched && value.status === "not_invoked") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: dispatched traces cannot use not_invoked`,
      });
    }
    if (value.dispatched && value.extra_model_calls < 1) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: dispatched traces must record at least one extra model call`,
      });
    }
    if (value.dispatched && value.task_id.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: dispatched traces must include a task_id`,
      });
    }
    if (value.suppressed_as_duplicate && value.dispatched) {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: suppressed duplicates must not be independently dispatched`,
      });
    }
    if (value.entered_findings && value.status !== "succeeded") {
      ctx.addIssue({
        code: "custom",
        message: `${value.case_id}: only succeeded traces may enter findings`,
      });
    }
  });

export type AgentOrchestrationDevCase = z.infer<typeof agentOrchestrationDevCaseSchema>;
export type AgentOrchestrationDevDataset = z.infer<typeof agentOrchestrationDevDatasetSchema>;
export type AgentOrchestrationDevTrace = z.infer<typeof agentOrchestrationDevTraceSchema>;

const DATASET_PATH = join(dirname(fileURLToPath(import.meta.url)), "dataset.json");

export function agentOrchestrationDevDatasetPath(): string {
  return DATASET_PATH;
}

export function loadAgentOrchestrationDevDataset(
  filePath: string = DATASET_PATH,
): AgentOrchestrationDevDataset {
  const parsed = agentOrchestrationDevDatasetSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  if (parsed.official_holdout || parsed.split === ("locked" as string)) {
    throw new Error(
      "Agent orchestration dev dataset must not claim official holdout or locked split",
    );
  }
  return parsed;
}

export function summarizeAgentOrchestrationDevCoverage(dataset: AgentOrchestrationDevDataset): {
  case_count: number;
  article_count: number;
  specialists: SpecialistId[];
  review_dimensions: ReviewDimension[];
  execution_statuses: ExecutionStatus[];
  dispatch_true: number;
  dispatch_false: number;
  expected_failures: number;
  duplicate_cases: number;
} {
  return {
    case_count: dataset.cases.length,
    article_count: new Set(dataset.cases.map((item) => item.article_id)).size,
    specialists: SPECIALIST_IDS.filter((specialist) =>
      dataset.cases.some((item) => item.specialist === specialist),
    ),
    review_dimensions: REVIEW_DIMENSIONS.filter((dimension) =>
      dataset.cases.some((item) => item.trigger_kind === dimension),
    ),
    execution_statuses: EXECUTION_STATUSES.filter((status) =>
      dataset.cases.some((item) => item.expected_status === status),
    ),
    dispatch_true: dataset.cases.filter((item) => item.should_dispatch).length,
    dispatch_false: dataset.cases.filter((item) => !item.should_dispatch).length,
    expected_failures: dataset.cases.filter((item) => item.expected_failure != null).length,
    duplicate_cases: dataset.cases.filter((item) => item.duplicate_of != null).length,
  };
}
