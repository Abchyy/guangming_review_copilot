import {
  AGENT_ORCHESTRATION_GATE_METRIC_IDS,
  type AgentOrchestrationDevCase,
  type AgentOrchestrationDevDataset,
  type AgentOrchestrationDevTrace,
  type AgentOrchestrationGateMetricId,
  agentOrchestrationDevTraceSchema,
} from "./schema";

export type AgentOrchestrationDevRunStatus = "not_run" | "scored";
export type AgentOrchestrationDevResultClass = "protocol_self_check" | "dev_system_run";

export type AgentOrchestrationDevMetrics = {
  dispatch_accuracy: number;
  parallel_budget_compliance_rate: number;
  failure_degradation_correctness: number;
  result_traceability_rate: number;
  duplicate_suppression_rate: number;
  extra_model_cost_compliance_rate: number;
};

export type AgentOrchestrationDevTally = {
  case_count: number;
  dispatch_tp: number;
  dispatch_tn: number;
  dispatch_fp: number;
  dispatch_fn: number;
  articles: number;
  parallel_budget_compliant_articles: number;
  cost_compliant_articles: number;
  dispatched_results: number;
  traceable_results: number;
  degradation_opportunities: number;
  correct_degradations: number;
  duplicate_cases: number;
  suppressed_duplicates: number;
};

export type AgentOrchestrationDevGateResult = {
  metric: AgentOrchestrationGateMetricId;
  observed: number;
  threshold: number;
  operator: "gte" | "eq";
  hardness: "hard" | "soft";
  passed: boolean;
};

export type AgentOrchestrationDevScorecard = {
  protocol_id: string;
  protocol_version: string;
  dataset_version: string;
  role: "development_only";
  official_holdout: false;
  may_claim_official_locked_generalization: false;
  result_class: AgentOrchestrationDevResultClass;
  run_status: AgentOrchestrationDevRunStatus;
  coverage_complete: boolean | null;
  case_count: number;
  metrics: AgentOrchestrationDevMetrics | null;
  tally: AgentOrchestrationDevTally | null;
  gates: AgentOrchestrationDevGateResult[] | null;
  all_gates_passed: boolean | null;
  diagnostics: {
    missing_case_ids: string[];
    extra_case_ids: string[];
    status_match_rate: number | null;
  };
  disclaimer: string;
};

const UNOFFICIAL_DISCLAIMER =
  "开发评估分数不能作为 official locked 或 holdout 证据。not_run 不得写成通过。";

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function gatePassed(observed: number, operator: "gte" | "eq", threshold: number): boolean {
  if (operator === "eq") {
    return observed === threshold;
  }
  return observed >= threshold;
}

function tracesByCaseId(traces: AgentOrchestrationDevTrace[]): Map<string, AgentOrchestrationDevTrace> {
  const map = new Map<string, AgentOrchestrationDevTrace>();
  for (const trace of traces) {
    if (map.has(trace.case_id)) {
      throw new Error(`Duplicate agent-orchestration-dev trace for ${trace.case_id}`);
    }
    map.set(trace.case_id, agentOrchestrationDevTraceSchema.parse(trace));
  }
  return map;
}

function resultIsTraceable(item: AgentOrchestrationDevCase, trace: AgentOrchestrationDevTrace): boolean {
  if (trace.task_id.trim().length === 0) {
    return false;
  }
  if (trace.specialist !== item.specialist) {
    return false;
  }
  if (trace.status === "succeeded") {
    return trace.result_locator.trim().length > 0 && trace.result_excerpt.trim().length > 0;
  }
  return true;
}

function degradationOpportunity(item: AgentOrchestrationDevCase, trace: AgentOrchestrationDevTrace): boolean {
  return (
    item.expected_failure != null ||
    trace.failure != null ||
    trace.status === "failed" ||
    trace.status === "timed_out"
  );
}

function overDeadline(
  dataset: AgentOrchestrationDevDataset,
  trace: AgentOrchestrationDevTrace,
): boolean {
  return trace.elapsed_ms > dataset.orchestration_budget.specialist_deadline_ms;
}

function degradationCorrect(
  dataset: AgentOrchestrationDevDataset,
  item: AgentOrchestrationDevCase,
  trace: AgentOrchestrationDevTrace,
): boolean {
  if (trace.entered_findings || trace.status === "succeeded") {
    return false;
  }
  if (item.expected_failure === "timeout") {
    return trace.status === "timed_out" && (trace.failure?.kind === "timeout" || trace.failure == null);
  }
  if (item.expected_failure === "provider_error") {
    return trace.status === "failed" && (trace.failure?.kind === "provider_error" || trace.failure == null);
  }
  if (overDeadline(dataset, trace) && trace.dispatched) {
    return trace.status === "timed_out" && !trace.entered_findings;
  }
  return trace.status === "failed" || trace.status === "timed_out";
}

function duplicateSuppressed(item: AgentOrchestrationDevCase, trace: AgentOrchestrationDevTrace): boolean {
  return (
    item.duplicate_of != null &&
    !trace.dispatched &&
    trace.suppressed_as_duplicate &&
    trace.extra_model_calls === 0 &&
    trace.status === "not_invoked"
  );
}

export function unevaluatedAgentOrchestrationDevScorecard(
  dataset: AgentOrchestrationDevDataset,
  resultClass: AgentOrchestrationDevResultClass = "dev_system_run",
): AgentOrchestrationDevScorecard {
  return {
    protocol_id: dataset.protocol_id,
    protocol_version: dataset.protocol_version,
    dataset_version: dataset.dataset_version,
    role: "development_only",
    official_holdout: false,
    may_claim_official_locked_generalization: false,
    result_class: resultClass,
    run_status: "not_run",
    coverage_complete: null,
    case_count: dataset.cases.length,
    metrics: null,
    tally: null,
    gates: null,
    all_gates_passed: null,
    diagnostics: {
      missing_case_ids: dataset.cases.map((item) => item.case_id),
      extra_case_ids: [],
      status_match_rate: null,
    },
    disclaimer: UNOFFICIAL_DISCLAIMER,
  };
}

export function scoreAgentOrchestrationDevRun(
  dataset: AgentOrchestrationDevDataset,
  traces: AgentOrchestrationDevTrace[],
  options?: { result_class?: AgentOrchestrationDevResultClass },
): AgentOrchestrationDevScorecard {
  const resultClass = options?.result_class ?? "dev_system_run";
  const byCase = tracesByCaseId(traces);
  const missing = dataset.cases.filter((item) => !byCase.has(item.case_id)).map((item) => item.case_id);
  const extra = [...byCase.keys()].filter((id) => !dataset.cases.some((item) => item.case_id === id));
  const coverageComplete = missing.length === 0 && extra.length === 0;

  let dispatchTp = 0;
  let dispatchTn = 0;
  let dispatchFp = 0;
  let dispatchFn = 0;
  let dispatchedResults = 0;
  let traceableResults = 0;
  let degradationOpportunities = 0;
  let correctDegradations = 0;
  let duplicateCases = 0;
  let suppressedDuplicates = 0;
  let statusMatches = 0;
  let scoredCases = 0;

  const dispatchedByArticle = new Map<string, number>();
  const peakParallelByArticle = new Map<string, number>();
  const extraCallsByArticle = new Map<string, number>();
  const extraTokensByArticle = new Map<string, number>();

  for (const item of dataset.cases) {
    const trace = byCase.get(item.case_id);
    if (item.duplicate_of != null) {
      duplicateCases += 1;
    }
    if (!trace) {
      dispatchFn += item.should_dispatch ? 1 : 0;
      continue;
    }
    scoredCases += 1;
    if (item.should_dispatch && trace.dispatched) dispatchTp += 1;
    else if (!item.should_dispatch && !trace.dispatched) dispatchTn += 1;
    else if (!item.should_dispatch && trace.dispatched) dispatchFp += 1;
    else dispatchFn += 1;

    dispatchedByArticle.set(
      item.article_id,
      (dispatchedByArticle.get(item.article_id) ?? 0) + (trace.dispatched ? 1 : 0),
    );
    peakParallelByArticle.set(
      item.article_id,
      Math.max(peakParallelByArticle.get(item.article_id) ?? 0, trace.observed_parallel),
    );
    extraCallsByArticle.set(
      item.article_id,
      (extraCallsByArticle.get(item.article_id) ?? 0) + trace.extra_model_calls,
    );
    extraTokensByArticle.set(
      item.article_id,
      (extraTokensByArticle.get(item.article_id) ?? 0) + trace.extra_tokens,
    );

    if (trace.dispatched) {
      dispatchedResults += 1;
      if (resultIsTraceable(item, trace)) {
        traceableResults += 1;
      }
    }

    const timedOut = overDeadline(dataset, trace) && trace.dispatched;
    if (degradationOpportunity(item, trace) || timedOut) {
      degradationOpportunities += 1;
      if (degradationCorrect(dataset, item, trace)) {
        correctDegradations += 1;
      }
    }
    if (item.duplicate_of != null && duplicateSuppressed(item, trace)) {
      suppressedDuplicates += 1;
    }
    if (trace.status === item.expected_status) {
      statusMatches += 1;
    }
  }

  const articleIds = [...new Set(dataset.cases.map((item) => item.article_id))];
  for (const articleId of articleIds) {
    if (!dispatchedByArticle.has(articleId)) dispatchedByArticle.set(articleId, 0);
    if (!peakParallelByArticle.has(articleId)) peakParallelByArticle.set(articleId, 0);
    if (!extraCallsByArticle.has(articleId)) extraCallsByArticle.set(articleId, 0);
    if (!extraTokensByArticle.has(articleId)) extraTokensByArticle.set(articleId, 0);
  }

  const parallelBudgetCompliantArticles = articleIds.filter((articleId) => {
    const dispatched = dispatchedByArticle.get(articleId) ?? 0;
    const peak = peakParallelByArticle.get(articleId) ?? 0;
    return (
      dispatched <= dataset.orchestration_budget.max_specialists_per_article &&
      peak <= dataset.orchestration_budget.max_parallel_invocations
    );
  }).length;

  const costCompliantArticles = articleIds.filter((articleId) => {
    const calls = extraCallsByArticle.get(articleId) ?? 0;
    const tokens = extraTokensByArticle.get(articleId) ?? 0;
    return (
      calls <= dataset.orchestration_budget.max_extra_model_calls_per_article &&
      tokens <= dataset.orchestration_budget.max_extra_tokens_per_article
    );
  }).length;

  const tally: AgentOrchestrationDevTally = {
    case_count: dataset.cases.length,
    dispatch_tp: dispatchTp,
    dispatch_tn: dispatchTn,
    dispatch_fp: dispatchFp,
    dispatch_fn: dispatchFn,
    articles: articleIds.length,
    parallel_budget_compliant_articles: parallelBudgetCompliantArticles,
    cost_compliant_articles: costCompliantArticles,
    dispatched_results: dispatchedResults,
    traceable_results: traceableResults,
    degradation_opportunities: degradationOpportunities,
    correct_degradations: correctDegradations,
    duplicate_cases: duplicateCases,
    suppressed_duplicates: suppressedDuplicates,
  };

  const metrics: AgentOrchestrationDevMetrics = {
    dispatch_accuracy: ratio(dispatchTp + dispatchTn, dataset.cases.length, 0),
    parallel_budget_compliance_rate: ratio(parallelBudgetCompliantArticles, articleIds.length, 0),
    failure_degradation_correctness: ratio(correctDegradations, degradationOpportunities, 1),
    result_traceability_rate: ratio(traceableResults, dispatchedResults, 1),
    duplicate_suppression_rate: ratio(suppressedDuplicates, duplicateCases, 1),
    extra_model_cost_compliance_rate: ratio(costCompliantArticles, articleIds.length, 0),
  };

  const gates: AgentOrchestrationDevGateResult[] = AGENT_ORCHESTRATION_GATE_METRIC_IDS.map((metric) => {
    const spec = dataset.gates[metric];
    return {
      metric,
      observed: metrics[metric],
      threshold: spec.threshold,
      operator: spec.operator,
      hardness: spec.hardness,
      passed: gatePassed(metrics[metric], spec.operator, spec.threshold),
    };
  });

  return {
    protocol_id: dataset.protocol_id,
    protocol_version: dataset.protocol_version,
    dataset_version: dataset.dataset_version,
    role: "development_only",
    official_holdout: false,
    may_claim_official_locked_generalization: false,
    result_class: resultClass,
    run_status: "scored",
    coverage_complete: coverageComplete,
    case_count: dataset.cases.length,
    metrics,
    tally,
    gates,
    all_gates_passed: coverageComplete && gates.every((gate) => gate.passed),
    diagnostics: {
      missing_case_ids: missing,
      extra_case_ids: extra,
      status_match_rate: ratio(statusMatches, scoredCases, 0),
    },
    disclaimer: UNOFFICIAL_DISCLAIMER,
  };
}
