import {
  FORBIDDEN_OUTBOUND_FIELDS,
  GATE_METRIC_IDS,
  type GateMetricId,
  type WebEvidenceDevCase,
  type WebEvidenceDevDataset,
  type WebEvidenceDevTrace,
  webEvidenceDevTraceSchema,
} from "./schema";

export type WebEvidenceDevRunStatus = "not_run" | "scored";
export type WebEvidenceDevResultClass = "protocol_self_check" | "dev_system_run";

export type WebEvidenceDevMetrics = {
  query_trigger_accuracy: number;
  query_budget_compliance_rate: number;
  authoritative_source_ratio: number;
  evidence_traceability_rate: number;
  failure_degradation_correctness: number;
  privacy_minimization_compliance_rate: number;
};

export type WebEvidenceDevTally = {
  case_count: number;
  trigger_tp: number;
  trigger_tn: number;
  trigger_fp: number;
  trigger_fn: number;
  articles: number;
  budget_compliant_articles: number;
  triggered_with_sources: number;
  authoritative_queries: number;
  evidence_items: number;
  traceable_evidence_items: number;
  degradation_opportunities: number;
  correct_degradations: number;
  privacy_compliant_cases: number;
};

export type WebEvidenceDevGateResult = {
  metric: GateMetricId;
  observed: number;
  threshold: number;
  operator: "gte" | "eq";
  hardness: "hard" | "soft";
  passed: boolean;
};

export type WebEvidenceDevScorecard = {
  protocol_id: string;
  protocol_version: string;
  dataset_version: string;
  role: "development_only";
  official_holdout: false;
  may_claim_official_locked_generalization: false;
  result_class: WebEvidenceDevResultClass;
  run_status: WebEvidenceDevRunStatus;
  coverage_complete: boolean | null;
  case_count: number;
  metrics: WebEvidenceDevMetrics | null;
  tally: WebEvidenceDevTally | null;
  gates: WebEvidenceDevGateResult[] | null;
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

function gatePassed(
  observed: number,
  operator: "gte" | "eq",
  threshold: number,
): boolean {
  if (operator === "eq") {
    return observed === threshold;
  }
  return observed >= threshold;
}

function tracesByCaseId(traces: WebEvidenceDevTrace[]): Map<string, WebEvidenceDevTrace> {
  const map = new Map<string, WebEvidenceDevTrace>();
  for (const trace of traces) {
    if (map.has(trace.case_id)) {
      throw new Error(`Duplicate web-evidence-dev trace for ${trace.case_id}`);
    }
    map.set(trace.case_id, webEvidenceDevTraceSchema.parse(trace));
  }
  return map;
}

function sourceIsAuthoritative(item: WebEvidenceDevCase, sourceClass: string): boolean {
  return item.allowed_source_classes.some((allowed) => allowed === sourceClass);
}

function evidenceIsTraceable(source: { locator: string; excerpt: string }): boolean {
  return source.locator.trim().length > 0 && source.excerpt.trim().length > 0;
}

function privacyCompliant(item: WebEvidenceDevCase, trace: WebEvidenceDevTrace): boolean {
  const forbidden = new Set<string>([...FORBIDDEN_OUTBOUND_FIELDS, ...item.forbidden_outbound_fields]);
  if (trace.outbound_fields.some((field) => forbidden.has(field))) {
    return false;
  }
  const haystack = [trace.query_text ?? "", ...trace.outbound_text_blobs].join("\n");
  for (const value of Object.values(item.sensitive_context)) {
    if (value.length > 0 && haystack.includes(value)) {
      return false;
    }
  }
  return true;
}

function degradationOpportunity(item: WebEvidenceDevCase, trace: WebEvidenceDevTrace): boolean {
  return item.expected_failure != null || trace.failure != null;
}

function degradationCorrect(trace: WebEvidenceDevTrace): boolean {
  return trace.status === "insufficient";
}

export function unevaluatedWebEvidenceDevScorecard(
  dataset: WebEvidenceDevDataset,
  resultClass: WebEvidenceDevResultClass = "dev_system_run",
): WebEvidenceDevScorecard {
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

export function scoreWebEvidenceDevRun(
  dataset: WebEvidenceDevDataset,
  traces: WebEvidenceDevTrace[],
  options?: { result_class?: WebEvidenceDevResultClass },
): WebEvidenceDevScorecard {
  const resultClass = options?.result_class ?? "dev_system_run";
  const byCase = tracesByCaseId(traces);
  const missing = dataset.cases.filter((item) => !byCase.has(item.case_id)).map((item) => item.case_id);
  const extra = [...byCase.keys()].filter((id) => !dataset.cases.some((item) => item.case_id === id));
  const coverageComplete = missing.length === 0 && extra.length === 0;

  let triggerTp = 0;
  let triggerTn = 0;
  let triggerFp = 0;
  let triggerFn = 0;
  let triggeredWithSources = 0;
  let authoritativeQueries = 0;
  let evidenceItems = 0;
  let traceableEvidenceItems = 0;
  let degradationOpportunities = 0;
  let correctDegradations = 0;
  let privacyCompliantCases = 0;
  let statusMatches = 0;
  let scoredCases = 0;

  const queriesByArticle = new Map<string, number>();
  const claimOverBudget = new Set<string>();

  for (const item of dataset.cases) {
    const trace = byCase.get(item.case_id);
    if (!trace) {
      triggerFn += item.should_trigger_query ? 1 : 0;
      continue;
    }
    scoredCases += 1;
    if (item.should_trigger_query && trace.triggered) triggerTp += 1;
    else if (!item.should_trigger_query && !trace.triggered) triggerTn += 1;
    else if (!item.should_trigger_query && trace.triggered) triggerFp += 1;
    else triggerFn += 1;

    if (trace.triggered) {
      queriesByArticle.set(item.article_id, (queriesByArticle.get(item.article_id) ?? 0) + trace.query_count);
      if (
        trace.query_count > dataset.query_budget.max_queries_per_claim ||
        trace.sources.length > dataset.query_budget.max_results_per_query
      ) {
        claimOverBudget.add(item.article_id);
      }
      if (trace.sources.length > 0) {
        triggeredWithSources += 1;
        if (trace.sources.every((source) => sourceIsAuthoritative(item, source.source_class))) {
          authoritativeQueries += 1;
        }
      }
      evidenceItems += trace.sources.length;
      traceableEvidenceItems += trace.sources.filter(evidenceIsTraceable).length;
    } else {
      queriesByArticle.set(item.article_id, queriesByArticle.get(item.article_id) ?? 0);
    }

    if (degradationOpportunity(item, trace)) {
      degradationOpportunities += 1;
      if (degradationCorrect(trace)) {
        correctDegradations += 1;
      }
    }
    if (privacyCompliant(item, trace)) {
      privacyCompliantCases += 1;
    }
    if (trace.status === item.expected_status) {
      statusMatches += 1;
    }
  }

  const articleIds = [...new Set(dataset.cases.map((item) => item.article_id))];
  for (const articleId of articleIds) {
    if (!queriesByArticle.has(articleId)) {
      queriesByArticle.set(articleId, 0);
    }
  }
  const budgetCompliantArticles = articleIds.filter((articleId) => {
    const queries = queriesByArticle.get(articleId) ?? 0;
    return queries <= dataset.query_budget.max_queries_per_article && !claimOverBudget.has(articleId);
  }).length;

  const tally: WebEvidenceDevTally = {
    case_count: dataset.cases.length,
    trigger_tp: triggerTp,
    trigger_tn: triggerTn,
    trigger_fp: triggerFp,
    trigger_fn: triggerFn,
    articles: articleIds.length,
    budget_compliant_articles: budgetCompliantArticles,
    triggered_with_sources: triggeredWithSources,
    authoritative_queries: authoritativeQueries,
    evidence_items: evidenceItems,
    traceable_evidence_items: traceableEvidenceItems,
    degradation_opportunities: degradationOpportunities,
    correct_degradations: correctDegradations,
    privacy_compliant_cases: privacyCompliantCases,
  };

  const metrics: WebEvidenceDevMetrics = {
    query_trigger_accuracy: ratio(triggerTp + triggerTn, dataset.cases.length, 0),
    query_budget_compliance_rate: ratio(budgetCompliantArticles, articleIds.length, 0),
    authoritative_source_ratio: ratio(authoritativeQueries, triggeredWithSources, 1),
    evidence_traceability_rate: ratio(traceableEvidenceItems, evidenceItems, 1),
    failure_degradation_correctness: ratio(correctDegradations, degradationOpportunities, 1),
    privacy_minimization_compliance_rate: ratio(privacyCompliantCases, dataset.cases.length, 0),
  };

  const gates: WebEvidenceDevGateResult[] = GATE_METRIC_IDS.map((metric) => {
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
