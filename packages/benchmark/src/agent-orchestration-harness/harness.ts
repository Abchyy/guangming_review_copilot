import type { SpecialistOrchestrationRun, SpecialistRuntime } from "@grc/contracts";

import {
  scoreAgentOrchestrationDevRun,
  type AgentOrchestrationDevScorecard,
} from "../agent-orchestration-eval/evaluate";
import type {
  AgentOrchestrationDevDataset,
  AgentOrchestrationDevTrace,
} from "../agent-orchestration-eval/schema";
import {
  adaptSpecialistOrchestrationRunsToDevTraces,
  type AgentOrchestrationDevArticleRun,
  type AgentOrchestrationDevRunObservation,
} from "./adapter";
import { buildSyntheticSpecialistRuntimeInputs } from "./synthetic";

export const AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS = "protocol_self_check" as const;

export type AgentOrchestrationDevHarnessScorecard = AgentOrchestrationDevScorecard & {
  result_class: typeof AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS;
};

function assertHarnessResultClass(
  resultClass: string | undefined,
): asserts resultClass is typeof AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS | undefined {
  if (resultClass != null && resultClass !== AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS) {
    throw new Error(
      "agent-orchestration-dev harness cannot emit dev_system_run or official conclusions from fixture/self-check traces",
    );
  }
}

export function scoreAgentOrchestrationDevHarnessTraces(
  dataset: AgentOrchestrationDevDataset,
  traces: AgentOrchestrationDevTrace[],
): AgentOrchestrationDevHarnessScorecard {
  const scorecard = scoreAgentOrchestrationDevRun(dataset, traces, {
    result_class: AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS,
  });
  if (scorecard.result_class !== AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS) {
    throw new Error("agent-orchestration-dev harness scorecard escaped protocol_self_check");
  }
  if (scorecard.official_holdout || scorecard.may_claim_official_locked_generalization) {
    throw new Error("agent-orchestration-dev harness scorecard cannot claim official holdout evidence");
  }
  return {
    ...scorecard,
    result_class: AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS,
  };
}

export function adaptAndScoreAgentOrchestrationDevRuns(input: {
  dataset: AgentOrchestrationDevDataset;
  runs: readonly AgentOrchestrationDevArticleRun[];
}): {
  traces: AgentOrchestrationDevTrace[];
  scorecard: AgentOrchestrationDevHarnessScorecard;
} {
  const traces = adaptSpecialistOrchestrationRunsToDevTraces({
    cases: input.dataset.cases,
    runs: input.runs,
  });
  return {
    traces,
    scorecard: scoreAgentOrchestrationDevHarnessTraces(input.dataset, traces),
  };
}

export async function runAgentOrchestrationDevHarness(input: {
  dataset: AgentOrchestrationDevDataset;
  orchestrate: SpecialistRuntime["orchestrate"];
  observationForArticle?: (
    articleId: string,
    run: SpecialistOrchestrationRun,
  ) => AgentOrchestrationDevRunObservation | undefined;
  result_class?: typeof AGENT_ORCHESTRATION_DEV_HARNESS_RESULT_CLASS;
}): Promise<{
  traces: AgentOrchestrationDevTrace[];
  scorecard: AgentOrchestrationDevHarnessScorecard;
  runs: Map<string, SpecialistOrchestrationRun>;
}> {
  assertHarnessResultClass(input.result_class);
  const inputs = buildSyntheticSpecialistRuntimeInputs(input.dataset);
  const runs = new Map<string, SpecialistOrchestrationRun>();
  const records: AgentOrchestrationDevArticleRun[] = [];
  await Promise.all(
    [...inputs.entries()].map(async ([articleId, runtimeInput]) => {
      const run = await input.orchestrate(runtimeInput);
      runs.set(articleId, run);
      records.push({
        article_id: articleId,
        run,
        observation: input.observationForArticle?.(articleId, run),
      });
    }),
  );
  const scored = adaptAndScoreAgentOrchestrationDevRuns({
    dataset: input.dataset,
    runs: records,
  });
  return { ...scored, runs };
}
