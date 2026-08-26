import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  EXECUTION_STATUSES,
  REVIEW_DIMENSIONS,
  SPECIALIST_IDS,
  loadAgentOrchestrationDevDataset,
  loadBenchmarkDataset,
  scoreAgentOrchestrationDevRun,
  summarizeAgentOrchestrationDevCoverage,
  unevaluatedAgentOrchestrationDevScorecard,
  agentOrchestrationDevDatasetPath,
  type AgentOrchestrationDevCase,
  type AgentOrchestrationDevDataset,
  type AgentOrchestrationDevTrace,
} from "@grc/benchmark";

const BUDGET_ARTICLE_ID = "ao-dev-art-budget";
const EXTRA_TOKENS_PER_CALL = 500;

function goldAlignedTrace(
  item: AgentOrchestrationDevCase,
  dispatched: boolean,
  observedParallel: number,
): AgentOrchestrationDevTrace {
  if (!dispatched) {
    return {
      case_id: item.case_id,
      dispatched: false,
      specialist: item.specialist,
      status: "not_invoked",
      task_id: "",
      elapsed_ms: 0,
      observed_parallel: 0,
      extra_model_calls: 0,
      extra_tokens: 0,
      result_locator: "",
      result_excerpt: "",
      entered_findings: false,
      suppressed_as_duplicate: item.duplicate_of != null,
      failure: null,
    };
  }

  if (item.expected_failure === "timeout") {
    return {
      case_id: item.case_id,
      dispatched: true,
      specialist: item.specialist,
      status: "timed_out",
      task_id: `task://${item.case_id}`,
      elapsed_ms: 2001,
      observed_parallel: observedParallel,
      extra_model_calls: 1,
      extra_tokens: 120,
      result_locator: "",
      result_excerpt: "",
      entered_findings: false,
      suppressed_as_duplicate: false,
      failure: { kind: "timeout" },
    };
  }

  if (item.expected_failure === "provider_error") {
    return {
      case_id: item.case_id,
      dispatched: true,
      specialist: item.specialist,
      status: "failed",
      task_id: `task://${item.case_id}`,
      elapsed_ms: 90,
      observed_parallel: observedParallel,
      extra_model_calls: 1,
      extra_tokens: 80,
      result_locator: "",
      result_excerpt: "",
      entered_findings: false,
      suppressed_as_duplicate: false,
      failure: { kind: "provider_error" },
    };
  }

  const evidence = item.fixture_evidence[0];
  return {
    case_id: item.case_id,
    dispatched: true,
    specialist: item.specialist,
    status: "succeeded",
    task_id: `task://${item.case_id}`,
    elapsed_ms: 80,
    observed_parallel: observedParallel,
    extra_model_calls: 1,
    extra_tokens: EXTRA_TOKENS_PER_CALL,
    result_locator: evidence?.locator ?? `fixture://orchestration/${item.case_id}`,
    result_excerpt: evidence?.excerpt ?? item.candidate_span.span_quote,
    entered_findings: item.expected_enters_findings,
    suppressed_as_duplicate: false,
    failure: null,
  };
}

function goldAlignedTraces(dataset: AgentOrchestrationDevDataset): AgentOrchestrationDevTrace[] {
  const dispatchedIds = new Set<string>();
  const byArticle = new Map<string, AgentOrchestrationDevCase[]>();
  for (const item of dataset.cases) {
    const list = byArticle.get(item.article_id) ?? [];
    list.push(item);
    byArticle.set(item.article_id, list);
  }
  const parallelByArticle = new Map<string, number>();
  for (const [articleId, cases] of byArticle) {
    const ordered = [...cases]
      .filter((item) => item.should_dispatch && item.duplicate_of == null)
      .sort((a, b) => a.dispatch_priority - b.dispatch_priority || a.case_id.localeCompare(b.case_id));
    const taken = ordered.slice(0, dataset.orchestration_budget.max_specialists_per_article);
    for (const item of taken) {
      dispatchedIds.add(item.case_id);
    }
    parallelByArticle.set(
      articleId,
      Math.min(taken.length, dataset.orchestration_budget.max_parallel_invocations),
    );
  }
  return dataset.cases.map((item) =>
    goldAlignedTrace(item, dispatchedIds.has(item.case_id), parallelByArticle.get(item.article_id) ?? 0),
  );
}

describe("agent orchestration development eval protocol", () => {
  const dataset = loadAgentOrchestrationDevDataset();
  const coverage = summarizeAgentOrchestrationDevCoverage(dataset);

  test("is a versioned development split and never an official holdout", () => {
    expect(dataset.protocol_id).toBe("agent-orchestration-dev-eval");
    expect(dataset.protocol_version).toBe("0.3.0");
    expect(dataset.dataset_version).toBe("0.3.0");
    expect(dataset.role).toBe("development_only");
    expect(dataset.split).toBe("dev");
    expect(dataset.official_holdout).toBe(false);
    expect(dataset.may_claim_official_locked_generalization).toBe(false);
    expect(dataset.orchestration_budget).toEqual({
      max_specialists_per_article: 2,
      max_parallel_invocations: 2,
      max_extra_model_calls_per_article: 2,
      max_extra_tokens_per_article: 4000,
      specialist_deadline_ms: 2000,
    });
    expect(dataset.provenance).toEqual({
      authoring: "handwritten_synthetic",
      contains_unpublished_real_articles: false,
      contains_real_pii: false,
      contains_holdout_gold: false,
      network_required_to_score: false,
    });
  });

  test("covers two specialists, review dimensions as trigger_kind, statuses, duplicates, and failures", () => {
    expect(SPECIALIST_IDS).toEqual(["fact_check", "news_edit"]);
    expect(coverage.specialists).toEqual(["fact_check", "news_edit"]);
    expect(coverage.review_dimensions).toEqual([...REVIEW_DIMENSIONS]);
    expect(coverage.execution_statuses).toEqual([...EXECUTION_STATUSES]);
    expect(dataset.enumerations.specialist_ids).toEqual(["fact_check", "news_edit"]);
    expect(dataset.enumerations.review_dimensions).toEqual(["entity", "policy", "numeric", "citation"]);
    expect(coverage.dispatch_true).toBeGreaterThanOrEqual(10);
    expect(coverage.dispatch_false).toBeGreaterThanOrEqual(6);
    expect(coverage.expected_failures).toBe(2);
    expect(coverage.duplicate_cases).toBe(1);
    expect(coverage.case_count).toBe(20);
    for (const specialist of SPECIALIST_IDS) {
      const rows = dataset.cases.filter((item) => item.specialist === specialist);
      expect(rows.some((item) => item.should_dispatch)).toBe(true);
      expect(rows.some((item) => !item.should_dispatch)).toBe(true);
    }
    for (const item of dataset.cases) {
      expect(["fact_check", "news_edit"]).toContain(item.specialist);
      expect(["entity", "policy", "numeric", "citation"]).not.toContain(item.specialist);
    }
    expect(dataset.enumerations.trigger_kinds).toEqual([
      "entity",
      "policy",
      "numeric",
      "citation",
      "wording",
      "consistency",
      "basic_text",
      "none",
    ]);
    expect(
      dataset.cases.some(
        (item) =>
          item.specialist === "news_edit" &&
          item.trigger_kind === "consistency" &&
          item.should_dispatch,
      ),
    ).toBe(true);
    const basicText = dataset.cases.filter((item) => item.trigger_kind === "basic_text");
    expect(basicText.length).toBeGreaterThan(0);
    for (const item of basicText) {
      expect(item.should_dispatch).toBe(false);
      expect(item.expected_failure).toBeNull();
      expect(item.expected_enters_findings).toBe(false);
    }
    for (const item of dataset.cases) {
      if (
        item.specialist === "news_edit" &&
        (item.should_dispatch || item.expected_failure != null)
      ) {
        expect(item.trigger_kind).not.toBe("basic_text");
        expect(["wording", "consistency"]).toContain(item.trigger_kind);
      }
    }
  });

  test("every case has the required adjudication fields", () => {
    for (const item of dataset.cases) {
      expect(item.candidate_span.text.length).toBeGreaterThan(0);
      expect(item.article_excerpt.includes(item.candidate_span.span_quote)).toBe(true);
      expect(item.adjudication_hint.length).toBeGreaterThan(0);
      if (item.should_dispatch) {
        expect(item.expected_status).not.toBe("not_invoked");
      } else {
        expect(item.expected_status).toBe("not_invoked");
        expect(item.expected_enters_findings).toBe(false);
      }
      if (item.duplicate_of) {
        expect(item.should_dispatch).toBe(false);
        const canonical = dataset.cases.find((row) => row.case_id === item.duplicate_of);
        expect(canonical).toBeDefined();
        expect(canonical?.article_id).toBe(item.article_id);
        expect(canonical?.specialist).toBe(item.specialist);
      }
    }
  });

  test("does not reuse in-repo review benchmark or holdout article ids", () => {
    const reviewDataset = loadBenchmarkDataset();
    const reviewArticleIds = new Set(reviewDataset.articles.map((item) => item.article_id));
    for (const item of dataset.cases) {
      expect(item.article_id.startsWith("ao-dev-art-")).toBe(true);
      expect(item.case_id.startsWith("ao-dev-")).toBe(true);
      expect(reviewArticleIds.has(item.article_id)).toBe(false);
      expect(item.article_id.startsWith("lock-")).toBe(false);
      expect(item.case_id.includes("holdout")).toBe(false);
    }
  });

  test("synthetic fixtures do not embed real contact PII or holdout identifiers", () => {
    const raw = readFileSync(agentOrchestrationDevDatasetPath(), "utf8");
    expect(raw).not.toMatch(/\b1[3-9]\d{9}\b/);
    expect(raw).not.toMatch(/\b\d{17}[\dXx]\b/);
    expect(raw).not.toMatch(/"holdout_id"\s*:/);
    expect(raw).not.toContain("HOLDOUT_CUSTODIAN");
    for (const item of dataset.cases) {
      expect(item.article_excerpt).not.toMatch(/@gmail\.com|@qq\.com|@163\.com/i);
      expect(item.article_excerpt).not.toContain("holdout");
      expect(item.candidate_span.text).not.toContain("holdout");
    }
  });

  test("does not load product runtime, contracts, holdout, or the network", () => {
    const sourceRoot = join(process.cwd(), "packages/benchmark/src/agent-orchestration-eval");
    const files = ["index.ts", "schema.ts", "evaluate.ts"];
    for (const name of files) {
      const text = readFileSync(join(sourceRoot, name), "utf8");
      expect(text).not.toContain("@grc/review-core");
      expect(text).not.toContain("@grc/providers");
      expect(text).not.toContain("@grc/contracts");
      expect(text).not.toContain("@grc/holdout-protocol");
      expect(text).not.toContain("@grc/web-evidence");
      expect(text).not.toContain("fetch(");
      expect(text).not.toContain("HOLDOUT_CUSTODIAN");
    }
  });

  test("unevaluated scorecard is not_run and does not invent a pass", () => {
    const scorecard = unevaluatedAgentOrchestrationDevScorecard(dataset);
    expect(scorecard.run_status).toBe("not_run");
    expect(scorecard.all_gates_passed).toBeNull();
    expect(scorecard.metrics).toBeNull();
    expect(scorecard.official_holdout).toBe(false);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
    expect(scorecard.disclaimer).toContain("不能作为 official locked");
  });

  test("protocol self-check traces exercise the scorer without claiming a product pass", () => {
    const scorecard = scoreAgentOrchestrationDevRun(dataset, goldAlignedTraces(dataset), {
      result_class: "protocol_self_check",
    });
    expect(scorecard.result_class).toBe("protocol_self_check");
    expect(scorecard.run_status).toBe("scored");
    expect(scorecard.coverage_complete).toBe(true);
    expect(scorecard.metrics).not.toBeNull();
    expect(scorecard.tally?.dispatch_fn).toBe(2);
    expect(scorecard.tally?.dispatch_fp).toBe(0);
    expect(scorecard.metrics?.dispatch_accuracy).toBe(18 / 20);
    expect(scorecard.metrics?.parallel_budget_compliance_rate).toBe(1);
    expect(scorecard.metrics?.failure_degradation_correctness).toBe(1);
    expect(scorecard.metrics?.result_traceability_rate).toBe(1);
    expect(scorecard.metrics?.duplicate_suppression_rate).toBe(1);
    expect(scorecard.metrics?.extra_model_cost_compliance_rate).toBe(1);
    expect(scorecard.all_gates_passed).toBe(true);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
    expect(scorecard.disclaimer).toContain("not_run 不得写成通过");
  });

  test("incomplete traces fail closed instead of reporting a pass", () => {
    const traces = goldAlignedTraces(dataset).slice(0, 3);
    const scorecard = scoreAgentOrchestrationDevRun(dataset, traces, {
      result_class: "protocol_self_check",
    });
    expect(scorecard.coverage_complete).toBe(false);
    expect(scorecard.all_gates_passed).toBe(false);
    expect(scorecard.diagnostics.missing_case_ids.length).toBeGreaterThan(0);
  });

  test("detects dispatch, parallel, degradation, traceability, duplicate, and cost violations", () => {
    const traces = goldAlignedTraces(dataset);
    const byId = new Map(traces.map((item) => [item.case_id, item]));

    const skip = byId.get("ao-dev-002-fact-entity-skip");
    const timeout = byId.get("ao-dev-009-timeout-fact-check");
    const success = byId.get("ao-dev-001-fact-entity-dispatch");
    const duplicate = byId.get("ao-dev-012-dup-repeat-fact");
    const budgetSkipped = traces.find((item) => {
      const gold = dataset.cases.find((row) => row.case_id === item.case_id);
      return gold?.article_id === BUDGET_ARTICLE_ID && gold.should_dispatch && !item.dispatched;
    });
    if (!skip || !timeout || !success || !duplicate || !budgetSkipped) {
      throw new Error("required protocol self-check traces are missing");
    }

    skip.dispatched = true;
    skip.status = "succeeded";
    skip.task_id = "task://skip-fp";
    skip.extra_model_calls = 1;
    skip.extra_tokens = EXTRA_TOKENS_PER_CALL;
    skip.observed_parallel = 1;
    skip.result_locator = "fixture://skip";
    skip.result_excerpt = "张叔";
    skip.entered_findings = true;
    skip.suppressed_as_duplicate = false;

    timeout.status = "succeeded";
    timeout.entered_findings = true;
    timeout.result_locator = "fixture://timeout-leaked";
    timeout.result_excerpt = "不应进入 Finding";
    timeout.failure = { kind: "timeout" };

    success.result_locator = "";
    success.result_excerpt = "";

    duplicate.dispatched = true;
    duplicate.suppressed_as_duplicate = false;
    duplicate.status = "succeeded";
    duplicate.task_id = "task://dup-extra";
    duplicate.extra_model_calls = 1;
    duplicate.extra_tokens = EXTRA_TOKENS_PER_CALL;
    duplicate.result_locator = "fixture://dup";
    duplicate.result_excerpt = "课后服务要实现全覆盖";
    duplicate.entered_findings = true;

    budgetSkipped.dispatched = true;
    budgetSkipped.status = "succeeded";
    budgetSkipped.task_id = "task://budget-overflow";
    budgetSkipped.extra_model_calls = 1;
    budgetSkipped.extra_tokens = 5000;
    budgetSkipped.observed_parallel = 3;
    budgetSkipped.result_locator = "fixture://budget";
    budgetSkipped.result_excerpt = "budget overflow";
    budgetSkipped.entered_findings = true;
    budgetSkipped.suppressed_as_duplicate = false;

    const scorecard = scoreAgentOrchestrationDevRun(dataset, traces, {
      result_class: "protocol_self_check",
    });
    expect(scorecard.tally?.dispatch_fp).toBeGreaterThanOrEqual(1);
    expect(scorecard.metrics?.parallel_budget_compliance_rate).toBeLessThan(1);
    expect(scorecard.metrics?.failure_degradation_correctness).toBeLessThan(1);
    expect(scorecard.metrics?.result_traceability_rate).toBeLessThan(1);
    expect(scorecard.metrics?.duplicate_suppression_rate).toBeLessThan(1);
    expect(scorecard.metrics?.extra_model_cost_compliance_rate).toBeLessThan(1);
    expect(scorecard.all_gates_passed).toBe(false);
    const failed = new Set(
      (scorecard.gates ?? []).filter((gate) => !gate.passed).map((gate) => gate.metric),
    );
    expect(failed.has("parallel_budget_compliance_rate")).toBe(true);
    expect(failed.has("failure_degradation_correctness")).toBe(true);
    expect(failed.has("duplicate_suppression_rate")).toBe(true);
    expect(failed.has("extra_model_cost_compliance_rate")).toBe(true);
  });

  test("defined gates match the documented development thresholds", () => {
    expect(dataset.gates).toEqual({
      dispatch_accuracy: { operator: "gte", threshold: 0.85, hardness: "soft" },
      parallel_budget_compliance_rate: { operator: "eq", threshold: 1, hardness: "hard" },
      failure_degradation_correctness: { operator: "eq", threshold: 1, hardness: "hard" },
      result_traceability_rate: { operator: "gte", threshold: 0.9, hardness: "soft" },
      duplicate_suppression_rate: { operator: "eq", threshold: 1, hardness: "hard" },
      extra_model_cost_compliance_rate: { operator: "eq", threshold: 1, hardness: "hard" },
    });
  });
});
