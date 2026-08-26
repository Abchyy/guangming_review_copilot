import type {
  CanonicalArticle,
  FindingType,
  Specialist,
  SpecialistId,
  SpecialistOrchestrationRun,
  SpecialistPreliminaryFinding,
  SpecialistResult,
  SpecialistRetrievedEvidence,
  SpecialistTask,
} from "@grc/contracts";
import {
  SPECIALIST_MAX_PER_ARTICLE,
  parseSpecialistOrchestrationRun,
  parseSpecialistResult,
  parseSpecialistTask,
} from "@grc/contracts";

import {
  DEFAULT_SPECIALIST_DEADLINE_MS,
  DEFAULT_SPECIALIST_MAX_CANDIDATES,
  FAKE_SPECIALIST_MODEL,
  FAKE_SPECIALIST_PROVIDER,
  SPECIALIST_TARGET_MODEL,
  isSpecialistOrchestrationEnabled,
  specialistBudgetLimit,
  type EnvLike,
} from "./config";
import { judgeSpecialistResults } from "./conflict";
import { SpecialistExecutionError, SpecialistTimeoutError } from "./errors";
import { createFakeSpecialists } from "./fake-specialists";
import { evidenceForFragments, extractFragments, fragmentToSpan } from "./fragments";
import { SPECIALIST_ROLE_FINDING_TYPES, isModelSpecialistId } from "./roles";
import { selectSpecialists } from "./router";
import { withDeadline } from "./timeout";

export type OrchestrateSpecialistsInput = {
  article: CanonicalArticle;
  findings: readonly SpecialistPreliminaryFinding[];
  retrievedEvidence?: readonly SpecialistRetrievedEvidence[];
};

export type SpecialistOrchestratorOptions = {
  maxSpecialists?: number;
  deadlineMs?: number;
  maxCandidates?: number;
  nowMs?: () => number;
};

export type SpecialistOrchestrator = {
  orchestrate(input: OrchestrateSpecialistsInput): Promise<SpecialistOrchestrationRun>;
};

function findingsForSpecialist(
  specialist: SpecialistId,
  findings: readonly SpecialistPreliminaryFinding[],
): SpecialistPreliminaryFinding[] {
  if (!isModelSpecialistId(specialist)) {
    return [];
  }
  const allowed = new Set<FindingType>(SPECIALIST_ROLE_FINDING_TYPES[specialist]);
  return findings.filter((item) => allowed.has(item.type));
}

function buildTask(input: {
  specialist: SpecialistId;
  article: CanonicalArticle;
  findings: readonly SpecialistPreliminaryFinding[];
  retrievedEvidence: readonly SpecialistRetrievedEvidence[];
  deadlineMs: number;
  maxCandidates: number;
}): SpecialistTask {
  const relevantFindings = findingsForSpecialist(input.specialist, input.findings);
  const fragments = extractFragments(input.article, relevantFindings);
  const retrievedEvidence = evidenceForFragments(
    fragments,
    relevantFindings,
    input.retrievedEvidence,
  );
  return parseSpecialistTask({
    taskId: `${input.specialist}:1`,
    specialist: input.specialist,
    fragments,
    preliminaryFindings: relevantFindings,
    candidateSpans: fragments.map(fragmentToSpan),
    retrievedEvidence,
    constraints: {
      maxCandidates: input.maxCandidates,
      deadlineMs: input.deadlineMs,
      allowExternalRetrieval: false,
    },
  });
}

function syntheticResult(
  task: SpecialistTask,
  status: "failed" | "timed_out",
  elapsedMs: number,
  warning: string,
): SpecialistResult {
  return parseSpecialistResult({
    taskId: task.taskId,
    candidates: [],
    provenance: {
      taskId: task.taskId,
      specialist: task.specialist,
      invoked: true,
      status,
      provider: FAKE_SPECIALIST_PROVIDER,
      model: FAKE_SPECIALIST_MODEL,
      elapsedMs,
    },
    warnings: [warning],
  });
}

async function runOne(
  specialist: Specialist,
  task: SpecialistTask,
  nowMs: () => number,
): Promise<SpecialistResult> {
  const started = nowMs();
  const work = specialist.run(task);
  void work.catch(() => undefined);
  try {
    const raw = await withDeadline(work, task.constraints.deadlineMs);
    const parsed = parseSpecialistResult(raw);
    return {
      ...parsed,
      provenance: {
        ...parsed.provenance,
        taskId: task.taskId,
        specialist: task.specialist,
        invoked: true,
        elapsedMs: Math.max(0, nowMs() - started),
      },
    };
  } catch (error) {
    const elapsedMs = Math.max(0, nowMs() - started);
    if (error instanceof SpecialistTimeoutError) {
      return syntheticResult(task, "timed_out", elapsedMs, error.message);
    }
    const message =
      error instanceof Error ? error.message : "specialist failed without an error message";
    return syntheticResult(task, "failed", elapsedMs, message);
  }
}

export function createSpecialistOrchestrator(
  specialists: readonly Specialist[],
  options: SpecialistOrchestratorOptions = {},
): SpecialistOrchestrator {
  const byId = new Map<SpecialistId, Specialist>();
  for (const specialist of specialists) {
    if (byId.has(specialist.id)) {
      throw new SpecialistExecutionError(`duplicate specialist id ${specialist.id}`);
    }
    byId.set(specialist.id, specialist);
  }
  const maxSpecialists = specialistBudgetLimit(options.maxSpecialists ?? SPECIALIST_MAX_PER_ARTICLE);
  const deadlineMs = options.deadlineMs ?? DEFAULT_SPECIALIST_DEADLINE_MS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_SPECIALIST_MAX_CANDIDATES;
  const nowMs = options.nowMs ?? Date.now;

  return {
    async orchestrate(input: OrchestrateSpecialistsInput): Promise<SpecialistOrchestrationRun> {
      const evidence = input.retrievedEvidence ?? [];
      const selected = selectSpecialists({
        findings: input.findings,
        available: [...byId.keys()],
        maxSpecialists,
      });
      const tasks = selected.dispatched.map((id) =>
        buildTask({
          specialist: id,
          article: input.article,
          findings: input.findings,
          retrievedEvidence: evidence,
          deadlineMs,
          maxCandidates,
        }),
      );
      const warnings = selected.skipped.map(
        (item) => `${item.specialist} skipped: ${item.reason}`,
      );
      const results = await Promise.all(
        tasks.map((task) => {
          const specialist = byId.get(task.specialist);
          if (!specialist) {
            return Promise.resolve(
              syntheticResult(task, "failed", 0, `${task.specialist} is not registered`),
            );
          }
          return runOne(specialist, task, nowMs);
        }),
      );
      for (const result of results) {
        warnings.push(...result.warnings);
      }
      const judgments = judgeSpecialistResults(tasks, results);
      return parseSpecialistOrchestrationRun({
        enabled: true,
        target_model: SPECIALIST_TARGET_MODEL,
        dispatched: selected.dispatched,
        skipped: selected.skipped,
        budget: {
          max_specialists: maxSpecialists,
          used: selected.dispatched.length,
        },
        results,
        judgments,
        warnings,
      });
    },
  };
}

export function createSpecialistOrchestratorFromEnv(
  env: EnvLike = process.env,
  options: SpecialistOrchestratorOptions = {},
): SpecialistOrchestrator | null {
  if (!isSpecialistOrchestrationEnabled(env)) {
    return null;
  }
  return createSpecialistOrchestrator(createFakeSpecialists(), options);
}
