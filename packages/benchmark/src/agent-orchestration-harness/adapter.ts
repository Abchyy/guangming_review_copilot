import type {
  ReviewCandidate,
  SpecialistJudgment,
  SpecialistOrchestrationRun,
  SpecialistResult,
} from "@grc/contracts";
import { parseSpecialistOrchestrationRun } from "@grc/contracts";

import {
  SPECIALIST_IDS,
  agentOrchestrationDevTraceSchema,
  type AgentOrchestrationDevCase,
  type AgentOrchestrationDevTrace,
  type SpecialistId as EvalSpecialistId,
} from "../agent-orchestration-eval/schema";

export type AgentOrchestrationDevRunObservation = {
  observed_parallel?: number;
  extra_model_calls_by_specialist?: Partial<Record<EvalSpecialistId, number>>;
  extra_tokens_by_specialist?: Partial<Record<EvalSpecialistId, number>>;
};

export type AgentOrchestrationDevArticleRun = {
  article_id: string;
  run: SpecialistOrchestrationRun;
  observation?: AgentOrchestrationDevRunObservation;
};

function isEvalSpecialist(id: string): id is EvalSpecialistId {
  return (SPECIALIST_IDS as readonly string[]).includes(id);
}

function runsByArticleId(
  runs: readonly AgentOrchestrationDevArticleRun[],
): Map<string, AgentOrchestrationDevArticleRun> {
  const map = new Map<string, AgentOrchestrationDevArticleRun>();
  for (const record of runs) {
    if (map.has(record.article_id)) {
      throw new Error(`Duplicate specialist orchestration run for ${record.article_id}`);
    }
    map.set(record.article_id, {
      ...record,
      run: parseSpecialistOrchestrationRun(record.run),
    });
  }
  return map;
}

function casesByArticle(
  cases: readonly AgentOrchestrationDevCase[],
): Map<string, AgentOrchestrationDevCase[]> {
  const map = new Map<string, AgentOrchestrationDevCase[]>();
  for (const item of cases) {
    const list = map.get(item.article_id) ?? [];
    list.push(item);
    map.set(item.article_id, list);
  }
  return map;
}

function sortCases(cases: readonly AgentOrchestrationDevCase[]): AgentOrchestrationDevCase[] {
  return [...cases].sort(
    (left, right) =>
      left.dispatch_priority - right.dispatch_priority || left.case_id.localeCompare(right.case_id),
  );
}

function dispatchedSpecialists(run: SpecialistOrchestrationRun | undefined): EvalSpecialistId[] {
  if (!run) {
    return [];
  }
  return run.dispatched.filter(isEvalSpecialist);
}

function invocationOwners(
  articleCases: readonly AgentOrchestrationDevCase[],
  run: SpecialistOrchestrationRun | undefined,
): Map<EvalSpecialistId, string> {
  const owners = new Map<EvalSpecialistId, string>();
  for (const specialist of dispatchedSpecialists(run)) {
    const owner = sortCases(articleCases).find(
      (item) => item.specialist === specialist && item.duplicate_of == null,
    );
    if (owner) {
      owners.set(specialist, owner.case_id);
    }
  }
  return owners;
}

function quoteMatches(value: string, item: AgentOrchestrationDevCase): boolean {
  const quote = item.candidate_span.span_quote;
  return value === quote || value.includes(quote) || quote.includes(value);
}

function resultForSpecialist(
  run: SpecialistOrchestrationRun | undefined,
  specialist: EvalSpecialistId,
): SpecialistResult | undefined {
  if (!run) {
    return undefined;
  }
  return run.results.find(
    (item) =>
      isEvalSpecialist(item.provenance.specialist) && item.provenance.specialist === specialist,
  );
}

function matchingCandidate(
  result: SpecialistResult | undefined,
  item: AgentOrchestrationDevCase,
): ReviewCandidate | undefined {
  return result?.candidates.find((candidate) => quoteMatches(candidate.source.exact_quote, item));
}

function matchingJudgment(
  run: SpecialistOrchestrationRun | undefined,
  item: AgentOrchestrationDevCase,
): SpecialistJudgment | undefined {
  return run?.judgments.find((judgment) => quoteMatches(judgment.quoted_text, item));
}

function locatorFromEvidence(
  candidate: ReviewCandidate | undefined,
  item: AgentOrchestrationDevCase,
): { locator: string; excerpt: string } {
  const evidence = candidate?.evidence.find(
    (entry) =>
      (entry.source_url != null && entry.source_url.length > 0) ||
      (entry.source_id != null && entry.source_id.length > 0),
  );
  if (evidence && (evidence.source_url || evidence.source_id) && evidence.excerpt.trim().length > 0) {
    return {
      locator: evidence.source_url ?? evidence.source_id ?? "",
      excerpt: evidence.excerpt,
    };
  }
  const fixture = item.fixture_evidence[0];
  if (fixture) {
    return { locator: fixture.locator, excerpt: fixture.excerpt };
  }
  const excerpt =
    candidate?.evidence.find((entry) => entry.excerpt.trim().length > 0)?.excerpt ??
    candidate?.reason ??
    "";
  return { locator: "", excerpt };
}

function failureForStatus(
  status: AgentOrchestrationDevTrace["status"],
): AgentOrchestrationDevTrace["failure"] {
  if (status === "timed_out") {
    return { kind: "timeout" };
  }
  if (status === "failed") {
    return { kind: "provider_error" };
  }
  return null;
}

function costForSpecialist(
  specialist: EvalSpecialistId,
  observation: AgentOrchestrationDevRunObservation | undefined,
): { calls: number; tokens: number } {
  return {
    calls: observation?.extra_model_calls_by_specialist?.[specialist] ?? 1,
    tokens: observation?.extra_tokens_by_specialist?.[specialist] ?? 0,
  };
}

function leftoverCost(
  articleCases: readonly AgentOrchestrationDevCase[],
  run: SpecialistOrchestrationRun | undefined,
  owners: Map<EvalSpecialistId, string>,
  observation: AgentOrchestrationDevRunObservation | undefined,
): { case_id: string; calls: number; tokens: number } | undefined {
  const leftover = dispatchedSpecialists(run).filter((specialist) => !owners.has(specialist));
  if (leftover.length === 0) {
    return undefined;
  }
  const collectorId = sortCases(articleCases).find((item) =>
    [...owners.values()].includes(item.case_id),
  )?.case_id;
  if (!collectorId) {
    return undefined;
  }
  let calls = 0;
  let tokens = 0;
  for (const specialist of leftover) {
    const cost = costForSpecialist(specialist, observation);
    calls += cost.calls;
    tokens += cost.tokens;
  }
  return { case_id: collectorId, calls, tokens };
}

function statusFromResult(
  result: SpecialistResult | undefined,
): AgentOrchestrationDevTrace["status"] {
  const status = result?.provenance.status;
  if (status === "succeeded" || status === "failed" || status === "timed_out") {
    return status;
  }
  return "failed";
}

function undispatchedTrace(
  item: AgentOrchestrationDevCase,
  suppressedAsDuplicate: boolean,
): AgentOrchestrationDevTrace {
  return agentOrchestrationDevTraceSchema.parse({
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
    suppressed_as_duplicate: suppressedAsDuplicate,
    failure: null,
  });
}

function dispatchedTrace(input: {
  item: AgentOrchestrationDevCase;
  result: SpecialistResult | undefined;
  run: SpecialistOrchestrationRun;
  observedParallel: number;
  extraModelCalls: number;
  extraTokens: number;
}): AgentOrchestrationDevTrace {
  const status = input.result ? statusFromResult(input.result) : "failed";
  const candidate = matchingCandidate(input.result, input.item);
  const judgment = matchingJudgment(input.run, input.item);
  const failure = failureForStatus(status);
  const located = status === "succeeded" ? locatorFromEvidence(candidate, input.item) : { locator: "", excerpt: "" };
  const enteredFindings =
    status === "succeeded" &&
    failure == null &&
    candidate != null &&
    judgment?.decision !== "verify";
  return agentOrchestrationDevTraceSchema.parse({
    case_id: input.item.case_id,
    dispatched: true,
    specialist: input.item.specialist,
    status,
    task_id: input.result?.taskId ?? input.result?.provenance.taskId ?? `${input.item.specialist}:1`,
    elapsed_ms: input.result?.provenance.elapsedMs ?? 0,
    observed_parallel: input.observedParallel,
    extra_model_calls: input.extraModelCalls,
    extra_tokens: input.extraTokens,
    result_locator: located.locator,
    result_excerpt: located.excerpt,
    entered_findings: enteredFindings,
    suppressed_as_duplicate: false,
    failure,
  });
}

export function adaptSpecialistOrchestrationRunsToDevTraces(input: {
  cases: readonly AgentOrchestrationDevCase[];
  runs: readonly AgentOrchestrationDevArticleRun[];
}): AgentOrchestrationDevTrace[] {
  const runs = runsByArticleId(input.runs);
  const grouped = casesByArticle(input.cases);
  return input.cases.map((item) => {
    const record = runs.get(item.article_id);
    const articleCases = grouped.get(item.article_id) ?? [item];
    const run = record?.run;
    const owners = invocationOwners(articleCases, run);
    const dispatched = dispatchedSpecialists(run);
    const observedParallel =
      record?.observation?.observed_parallel ??
      dispatched.length;
    if (item.duplicate_of != null && owners.get(item.specialist) !== item.case_id) {
      return undispatchedTrace(item, true);
    }
    if (owners.get(item.specialist) !== item.case_id) {
      return undispatchedTrace(item, false);
    }
    if (!run) {
      return undispatchedTrace(item, false);
    }
    const ownCost = costForSpecialist(item.specialist, record?.observation);
    const leftover = leftoverCost(articleCases, run, owners, record?.observation);
    const extraModelCalls = ownCost.calls + (leftover?.case_id === item.case_id ? leftover.calls : 0);
    const extraTokens = ownCost.tokens + (leftover?.case_id === item.case_id ? leftover.tokens : 0);
    return dispatchedTrace({
      item,
      result: resultForSpecialist(run, item.specialist),
      run,
      observedParallel,
      extraModelCalls,
      extraTokens,
    });
  });
}

export function emptySpecialistOrchestrationRun(
  extras: Partial<SpecialistOrchestrationRun> = {},
): SpecialistOrchestrationRun {
  return parseSpecialistOrchestrationRun({
    enabled: true,
    target_model: extras.target_model ?? "deepseek-v4-flash",
    dispatched: extras.dispatched ?? [],
    skipped: extras.skipped ?? [],
    budget: extras.budget ?? { max_specialists: 2, used: extras.dispatched?.length ?? 0 },
    results: extras.results ?? [],
    judgments: extras.judgments ?? [],
    warnings: extras.warnings ?? [],
  });
}


