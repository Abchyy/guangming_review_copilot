import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS,
  adaptSpecialistOrchestrationRunsToDevTraces,
  buildSyntheticSpecialistRuntimeInput,
  buildSyntheticSpecialistRuntimeInputs,
  emptySpecialistOrchestrationRun,
  loadAgentOrchestrationDevDataset,
  runAgentOrchestrationDevHarness,
  scoreAgentOrchestrationDevHarnessTraces,
  syntheticFindingTypeForCase,
  type AgentOrchestrationDevCase,
} from "@grc/benchmark";
import type { SpecialistResult, SpecialistTask } from "@grc/contracts";
import { unobservedSpecialistCallFields } from "@grc/contracts";
import {
  createFakeSpecialists,
  createSpecialistRuntime,
} from "@grc/agent-orchestration";

const HARNESS_ROOT = join(process.cwd(), "packages/benchmark/src/agent-orchestration-harness");
const PROTOCOL_ROOT = join(process.cwd(), "packages/benchmark/src/agent-orchestration-eval");
const BUDGET_ARTICLE_ID = "ao-dev-art-budget";

function taskMentions(task: SpecialistTask, needle: string): boolean {
  return (
    task.fragments.some((item) => item.quoted_text.includes(needle)) ||
    task.preliminaryFindings.some((item) => item.source_span.quoted_text.includes(needle))
  );
}

function offlineFakeRuntime() {
  return createSpecialistRuntime(
    createFakeSpecialists({
      factCheck: {
        behaviorFor: (task) => (taskMentions(task, "青石市数据管理局") ? "timeout" : "success"),
      },
      newsEdit: {
        behaviorFor: (task) =>
          taskMentions(task, "部分工地将继续夜间作业") ? "failure" : "success",
      },
    }),
    { deadlineMs: 80 },
  );
}

function successResult(
  specialist: "fact_check" | "news_edit",
  item: AgentOrchestrationDevCase,
): SpecialistResult {
  const locator = item.fixture_evidence[0]?.locator ?? `fixture://orchestration/${item.case_id}`;
  const excerpt = item.fixture_evidence[0]?.excerpt ?? item.candidate_span.span_quote;
  return {
    taskId: `${specialist}:1`,
    candidates: [
      {
        type: specialist === "news_edit" ? "consistency" : "person",
        severity: "high",
        title: "synthetic",
        reason: excerpt,
        suggestion: { text: excerpt, replacement: null },
        confidence: 0.7,
        evidence: [
          {
            kind: "retrieved_source",
            excerpt,
            citation_validated: false,
            source_id: locator,
            source_url: locator,
          },
        ],
        source: {
          field: "body",
          exact_quote: item.candidate_span.span_quote,
          paragraph_index: 0,
          context_before: null,
          context_after: null,
        },
      },
    ],
    provenance: {
      taskId: `${specialist}:1`,
      specialist,
      invoked: true,
      status: "succeeded",
      provider: "fixture",
      model: "fake-specialist",
      elapsedMs: 12,
      ...unobservedSpecialistCallFields(),
    },
    warnings: [],
  };
}

describe("agent orchestration development harness", () => {
  const dataset = loadAgentOrchestrationDevDataset();

  test("stays on public contracts and synthetic fixtures", () => {
    const harnessFiles = readdirSync(HARNESS_ROOT).filter((name) => name.endsWith(".ts"));
    expect(harnessFiles.length).toBeGreaterThan(0);
    for (const name of harnessFiles) {
      const text = readFileSync(join(HARNESS_ROOT, name), "utf8");
      expect(text).not.toContain("@grc/review-core");
      expect(text).not.toContain("@grc/providers");
      expect(text).not.toContain("@grc/holdout-protocol");
      expect(text).not.toContain("@grc/agent-orchestration");
      expect(text).not.toContain("@grc/web-evidence");
      expect(text).not.toContain("apps/web");
      expect(text).not.toContain("fetch(");
      expect(text).not.toContain("HOLDOUT_CUSTODIAN");
      expect(text).not.toContain("HOLDOUT_GOLD");
    }
    expect(readFileSync(join(HARNESS_ROOT, "adapter.ts"), "utf8")).toContain("@grc/contracts");
    for (const name of ["index.ts", "schema.ts", "evaluate.ts"]) {
      const text = readFileSync(join(PROTOCOL_ROOT, name), "utf8");
      expect(text).not.toContain("@grc/contracts");
      expect(text).not.toContain("agent-orchestration-harness");
    }
  });

  test("synthetic inputs only emit specialist findings for dispatch/duplicate/basic_text fixtures", () => {
    const inputs = buildSyntheticSpecialistRuntimeInputs(dataset);
    const skip = inputs.get("ao-dev-art-entity-skip");
    const none = inputs.get("ao-dev-art-nospan");
    const basic = inputs.get("ao-dev-art-basic-text-skip");
    const entity = inputs.get("ao-dev-art-entity-a");
    const wording = dataset.cases.find((item) => item.case_id === "ao-dev-019-news-edit-wording-dispatch");
    const citation = dataset.cases.find((item) => item.case_id === "ao-dev-007-fact-citation-dispatch");
    if (!skip || !none || !basic || !entity || !wording || !citation) {
      throw new Error("required synthetic articles are missing");
    }
    expect(skip.findings).toEqual([]);
    expect(none.findings).toEqual([]);
    expect(basic.findings.every((item) => item.type === "basic_text")).toBe(true);
    expect(entity.findings.some((item) => item.type === "person")).toBe(true);
    expect(syntheticFindingTypeForCase(wording)).toBe("consistency");
    expect(syntheticFindingTypeForCase(citation)).toBe("external_fact");
    expect(entity.retrievedEvidence?.some((item) => item.source_url.startsWith("fixture://"))).toBe(true);
    expect(entity.article.title).toBe("ao-dev-art-entity-a");
  });

  test("adapter records dispatch, skip, duplicate suppression, and per-specialist cost", () => {
    const entity = dataset.cases.find((item) => item.case_id === "ao-dev-001-fact-entity-dispatch");
    const skip = dataset.cases.find((item) => item.case_id === "ao-dev-002-fact-entity-skip");
    const canonical = dataset.cases.find((item) => item.case_id === "ao-dev-011-dup-canonical-fact");
    const duplicate = dataset.cases.find((item) => item.case_id === "ao-dev-012-dup-repeat-fact");
    if (!entity || !skip || !canonical || !duplicate) {
      throw new Error("required adapter cases are missing");
    }
    const traces = adaptSpecialistOrchestrationRunsToDevTraces({
      cases: [entity, skip, canonical, duplicate],
      runs: [
        {
          article_id: entity.article_id,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check"],
            budget: { max_specialists: 2, used: 1 },
            results: [successResult("fact_check", entity)],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: entity.candidate_span.span_quote,
                decision: "keep",
                reason: "ok",
                specialist_ids: ["fact_check"],
                requires_verification: false,
              },
            ],
          }),
        },
        {
          article_id: skip.article_id,
          run: emptySpecialistOrchestrationRun(),
        },
        {
          article_id: canonical.article_id,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check"],
            budget: { max_specialists: 2, used: 1 },
            results: [successResult("fact_check", canonical)],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: canonical.candidate_span.span_quote,
                decision: "keep",
                reason: "ok",
                specialist_ids: ["fact_check"],
                requires_verification: false,
              },
            ],
          }),
        },
      ],
    });
    const byId = new Map(traces.map((item) => [item.case_id, item]));
    expect(byId.get(entity.case_id)?.dispatched).toBe(true);
    expect(byId.get(entity.case_id)?.status).toBe("succeeded");
    expect(byId.get(entity.case_id)?.result_locator.startsWith("fixture://")).toBe(true);
    expect(byId.get(entity.case_id)?.entered_findings).toBe(true);
    expect(byId.get(entity.case_id)?.extra_model_calls).toBe(1);
    expect(byId.get(skip.case_id)).toMatchObject({
      dispatched: false,
      status: "not_invoked",
      extra_model_calls: 0,
      suppressed_as_duplicate: false,
    });
    expect(byId.get(duplicate.case_id)).toMatchObject({
      dispatched: false,
      status: "not_invoked",
      extra_model_calls: 0,
      suppressed_as_duplicate: true,
    });
  });

  test("adapter attributes one invocation per specialist and leaves overflow spans undispatched", () => {
    const budgetCases = dataset.cases.filter((item) => item.article_id === BUDGET_ARTICLE_ID);
    const fact = budgetCases.find((item) => item.case_id === "ao-dev-013-budget-fact-entity");
    const news = budgetCases.find((item) => item.case_id === "ao-dev-014-budget-news-edit");
    if (!fact || !news) {
      throw new Error("budget cases are missing");
    }
    const traces = adaptSpecialistOrchestrationRunsToDevTraces({
      cases: budgetCases,
      runs: [
        {
          article_id: BUDGET_ARTICLE_ID,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check", "news_edit"],
            budget: { max_specialists: 2, used: 2 },
            results: [successResult("fact_check", fact), successResult("news_edit", news)],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: fact.candidate_span.span_quote,
                decision: "keep",
                reason: "ok",
                specialist_ids: ["fact_check"],
                requires_verification: false,
              },
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: news.candidate_span.span_quote,
                decision: "keep",
                reason: "ok",
                specialist_ids: ["news_edit"],
                requires_verification: false,
              },
            ],
          }),
        },
      ],
    });
    const byId = new Map(traces.map((item) => [item.case_id, item]));
    expect(byId.get("ao-dev-013-budget-fact-entity")?.dispatched).toBe(true);
    expect(byId.get("ao-dev-014-budget-news-edit")?.dispatched).toBe(true);
    expect(byId.get("ao-dev-015-budget-fact-numeric")?.dispatched).toBe(false);
    expect(byId.get("ao-dev-016-budget-fact-citation")?.dispatched).toBe(false);
    const extraCalls = traces.reduce((sum, item) => sum + item.extra_model_calls, 0);
    expect(extraCalls).toBe(2);
    expect(Math.max(...traces.map((item) => item.observed_parallel))).toBe(2);
  });

  test("adapter keeps timeout and provider failure out of findings", () => {
    const timeout = dataset.cases.find((item) => item.case_id === "ao-dev-009-timeout-fact-check");
    const failed = dataset.cases.find((item) => item.case_id === "ao-dev-010-fail-news-edit");
    if (!timeout || !failed) {
      throw new Error("degradation cases are missing");
    }
    const traces = adaptSpecialistOrchestrationRunsToDevTraces({
      cases: [timeout, failed],
      runs: [
        {
          article_id: timeout.article_id,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check"],
            results: [
              {
                taskId: "fact_check:1",
                candidates: [],
                provenance: {
                  taskId: "fact_check:1",
                  specialist: "fact_check",
                  invoked: true,
                  status: "timed_out",
                  provider: "fixture",
                  model: "fake-specialist",
                  elapsedMs: 80,
                  ...unobservedSpecialistCallFields(),
                },
                warnings: ["timed out"],
              },
            ],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: timeout.candidate_span.span_quote,
                decision: "verify",
                reason: "专项核验超时，待人工核实",
                specialist_ids: ["fact_check"],
                requires_verification: true,
              },
            ],
          }),
        },
        {
          article_id: failed.article_id,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["news_edit"],
            results: [
              {
                taskId: "news_edit:1",
                candidates: [],
                provenance: {
                  taskId: "news_edit:1",
                  specialist: "news_edit",
                  invoked: true,
                  status: "failed",
                  provider: "fixture",
                  model: "fake-specialist",
                  elapsedMs: 9,
                  ...unobservedSpecialistCallFields(),
                },
                warnings: ["provider failed"],
              },
            ],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: failed.candidate_span.span_quote,
                decision: "verify",
                reason: "专项核验失败，待人工核实",
                specialist_ids: ["news_edit"],
                requires_verification: true,
              },
            ],
          }),
        },
      ],
    });
    const byId = new Map(traces.map((item) => [item.case_id, item]));
    expect(byId.get(timeout.case_id)).toMatchObject({
      dispatched: true,
      status: "timed_out",
      entered_findings: false,
      extra_model_calls: 1,
      failure: { kind: "timeout" },
    });
    expect(byId.get(failed.case_id)).toMatchObject({
      dispatched: true,
      status: "failed",
      entered_findings: false,
      extra_model_calls: 1,
      failure: { kind: "provider_error" },
    });
  });

  test("fixture scoring cannot be labeled dev_system_run or official", async () => {
    const runtime = offlineFakeRuntime();
    await expect(
      runAgentOrchestrationDevHarness({
        dataset,
        orchestrate: (input) => runtime.orchestrate(input),
        result_class: "dev_system_run" as typeof AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS,
      }),
    ).rejects.toThrow(/cannot emit dev_system_run or official/);
    const scorecard = scoreAgentOrchestrationDevHarnessTraces(dataset, []);
    expect(scorecard.result_class).toBe("protocol_self_check");
    expect(scorecard.official_holdout).toBe(false);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
  });

  test("fake-specialist harness covers dispatch, budget, degradation, traceability, duplicates, and cost", async () => {
    const runtime = offlineFakeRuntime();
    const { traces, scorecard, runs } = await runAgentOrchestrationDevHarness({
      dataset,
      orchestrate: (input) => runtime.orchestrate(input),
    });
    const byId = new Map(traces.map((item) => [item.case_id, item]));

    expect(scorecard.result_class).toBe("protocol_self_check");
    expect(scorecard.run_status).toBe("scored");
    expect(scorecard.coverage_complete).toBe(true);
    expect(scorecard.official_holdout).toBe(false);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
    expect(scorecard.disclaimer).toContain("不能作为 official locked");

    expect(byId.get("ao-dev-001-fact-entity-dispatch")?.dispatched).toBe(true);
    expect(byId.get("ao-dev-002-fact-entity-skip")?.dispatched).toBe(false);
    expect(byId.get("ao-dev-019-news-edit-wording-dispatch")?.dispatched).toBe(true);
    expect(byId.get("ao-dev-020-basic-text-skip")?.dispatched).toBe(false);
    expect(scorecard.tally?.dispatch_fp).toBe(0);
    expect(scorecard.tally?.dispatch_fn).toBe(2);
    expect(scorecard.metrics?.dispatch_accuracy).toBe(18 / 20);

    const budgetRun = runs.get(BUDGET_ARTICLE_ID);
    expect(budgetRun?.dispatched).toEqual(["fact_check", "news_edit"]);
    expect(budgetRun?.budget.used).toBeLessThanOrEqual(2);
    expect(byId.get("ao-dev-013-budget-fact-entity")?.observed_parallel).toBe(2);
    expect(byId.get("ao-dev-015-budget-fact-numeric")?.dispatched).toBe(false);
    expect(scorecard.metrics?.parallel_budget_compliance_rate).toBe(1);

    expect(byId.get("ao-dev-009-timeout-fact-check")).toMatchObject({
      dispatched: true,
      status: "timed_out",
      entered_findings: false,
      failure: { kind: "timeout" },
    });
    expect(byId.get("ao-dev-010-fail-news-edit")).toMatchObject({
      dispatched: true,
      status: "failed",
      entered_findings: false,
      failure: { kind: "provider_error" },
    });
    expect(scorecard.metrics?.failure_degradation_correctness).toBe(1);

    const success = byId.get("ao-dev-001-fact-entity-dispatch");
    expect(success?.task_id.length).toBeGreaterThan(0);
    expect(success?.result_locator.startsWith("fixture://")).toBe(true);
    expect(success?.result_excerpt.length).toBeGreaterThan(0);
    expect(scorecard.metrics?.result_traceability_rate).toBe(1);

    expect(byId.get("ao-dev-012-dup-repeat-fact")).toMatchObject({
      dispatched: false,
      suppressed_as_duplicate: true,
      extra_model_calls: 0,
      status: "not_invoked",
    });
    expect(byId.get("ao-dev-011-dup-canonical-fact")?.dispatched).toBe(true);
    expect(scorecard.metrics?.duplicate_suppression_rate).toBe(1);

    const callsByArticle = new Map<string, number>();
    for (const item of dataset.cases) {
      const trace = byId.get(item.case_id);
      callsByArticle.set(
        item.article_id,
        (callsByArticle.get(item.article_id) ?? 0) + (trace?.extra_model_calls ?? 0),
      );
    }
    expect(Math.max(...callsByArticle.values())).toBeLessThanOrEqual(
      dataset.orchestration_budget.max_extra_model_calls_per_article,
    );
    expect(scorecard.metrics?.extra_model_cost_compliance_rate).toBe(1);
    expect(scorecard.all_gates_passed).toBe(true);
  });

  test("adapted violations still fail the corresponding gates", () => {
    const entity = dataset.cases.find((item) => item.case_id === "ao-dev-001-fact-entity-dispatch")!;
    const skip = dataset.cases.find((item) => item.case_id === "ao-dev-002-fact-entity-skip")!;
    const traces = adaptSpecialistOrchestrationRunsToDevTraces({
      cases: dataset.cases,
      runs: [
        {
          article_id: skip.article_id,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check"],
            results: [successResult("fact_check", { ...skip, fixture_evidence: entity.fixture_evidence })],
            judgments: [
              {
                field: "body",
                paragraph_index: 0,
                quoted_text: skip.candidate_span.span_quote,
                decision: "keep",
                reason: "ok",
                specialist_ids: ["fact_check"],
                requires_verification: false,
              },
            ],
          }),
        },
        {
          article_id: BUDGET_ARTICLE_ID,
          run: emptySpecialistOrchestrationRun({
            dispatched: ["fact_check", "news_edit"],
            results: [
              successResult(
                "fact_check",
                dataset.cases.find((item) => item.case_id === "ao-dev-013-budget-fact-entity")!,
              ),
              successResult(
                "news_edit",
                dataset.cases.find((item) => item.case_id === "ao-dev-014-budget-news-edit")!,
              ),
            ],
          }),
          observation: {
            observed_parallel: 3,
            extra_tokens_by_specialist: { fact_check: 5000, news_edit: 5000 },
          },
        },
      ],
    });
    const timeout = traces.find((item) => item.case_id === "ao-dev-009-timeout-fact-check");
    const duplicate = traces.find((item) => item.case_id === "ao-dev-012-dup-repeat-fact");
    const success = traces.find((item) => item.case_id === "ao-dev-001-fact-entity-dispatch");
    if (!timeout || !duplicate || !success) {
      throw new Error("violation traces are missing");
    }
    timeout.dispatched = true;
    timeout.status = "succeeded";
    timeout.task_id = "fact_check:1";
    timeout.extra_model_calls = 1;
    timeout.entered_findings = true;
    timeout.result_locator = "fixture://leaked";
    timeout.result_excerpt = "should not enter";
    timeout.failure = { kind: "timeout" };
    duplicate.dispatched = true;
    duplicate.suppressed_as_duplicate = false;
    duplicate.status = "succeeded";
    duplicate.task_id = "fact_check:dup";
    duplicate.extra_model_calls = 1;
    duplicate.result_locator = "fixture://dup";
    duplicate.result_excerpt = "课后服务要实现全覆盖";
    duplicate.entered_findings = true;
    success.result_locator = "";
    success.result_excerpt = "";
    success.dispatched = true;
    success.status = "succeeded";
    success.task_id = "fact_check:1";
    success.extra_model_calls = 1;

    const scored = scoreAgentOrchestrationDevHarnessTraces(dataset, traces);
    expect(scored.result_class).toBe("protocol_self_check");
    expect(scored.tally?.dispatch_fp).toBeGreaterThanOrEqual(1);
    expect(scored.metrics?.parallel_budget_compliance_rate).toBeLessThan(1);
    expect(scored.metrics?.failure_degradation_correctness).toBeLessThan(1);
    expect(scored.metrics?.result_traceability_rate).toBeLessThan(1);
    expect(scored.metrics?.duplicate_suppression_rate).toBeLessThan(1);
    expect(scored.metrics?.extra_model_cost_compliance_rate).toBeLessThan(1);
    expect(scored.all_gates_passed).toBe(false);
  });

  test("missing article runs stay not_invoked instead of inventing a product pass", () => {
    const traces = adaptSpecialistOrchestrationRunsToDevTraces({
      cases: dataset.cases,
      runs: [],
    });
    expect(traces.every((item) => item.dispatched === false && item.status === "not_invoked")).toBe(
      true,
    );
    const scorecard = scoreAgentOrchestrationDevHarnessTraces(dataset, traces);
    expect(scorecard.result_class).toBe("protocol_self_check");
    expect(scorecard.all_gates_passed).toBe(false);
    expect(scorecard.metrics?.dispatch_accuracy).toBeLessThan(dataset.gates.dispatch_accuracy.threshold);
  });

  test("synthetic article bodies stay on the public excerpt and do not pull holdout ids", () => {
    const input = buildSyntheticSpecialistRuntimeInput("ao-dev-art-dup", dataset.cases);
    expect(input.article.body).toContain("课后服务要实现全覆盖");
    expect(input.article.body).not.toContain("holdout");
    expect(JSON.stringify(input)).not.toContain("HOLDOUT_CUSTODIAN");
    expect(input.findings.length).toBeGreaterThan(0);
  });
});
