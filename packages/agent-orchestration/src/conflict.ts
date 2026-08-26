import type {
  ReviewCandidate,
  SpecialistId,
  SpecialistJudgment,
  SpecialistResult,
  SpecialistTask,
} from "@grc/contracts";

import {
  SPECIALIST_DISAGREEMENT_MESSAGE,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_PARTIAL_FAILURE_MESSAGE,
  SPECIALIST_TIMEOUT_MESSAGE,
} from "./config";

type SpanKey = string;

type SpanRecord = {
  field: ReviewCandidate["source"]["field"];
  paragraph_index: number;
  quoted_text: string;
  assigned: SpecialistId[];
  candidates: Partial<Record<SpecialistId, ReviewCandidate>>;
  statuses: Partial<Record<SpecialistId, SpecialistResult["provenance"]["status"]>>;
};

function spanKey(field: string, paragraphIndex: number, quoted: string): SpanKey {
  return `${field}:${paragraphIndex}:${quoted}`;
}

function sameConclusion(left: ReviewCandidate, right: ReviewCandidate): boolean {
  return left.type === right.type && left.suggestion.replacement === right.suggestion.replacement;
}

function ensureSpan(
  spans: Map<SpanKey, SpanRecord>,
  field: ReviewCandidate["source"]["field"],
  paragraphIndex: number,
  quoted: string,
): SpanRecord {
  const key = spanKey(field, paragraphIndex, quoted);
  const existing = spans.get(key);
  if (existing) {
    return existing;
  }
  const created: SpanRecord = {
    field,
    paragraph_index: paragraphIndex,
    quoted_text: quoted,
    assigned: [],
    candidates: {},
    statuses: {},
  };
  spans.set(key, created);
  return created;
}

export function judgeSpecialistResults(
  tasks: readonly SpecialistTask[],
  results: readonly SpecialistResult[],
): SpecialistJudgment[] {
  const spans = new Map<SpanKey, SpanRecord>();
  const resultByTask = new Map(results.map((item) => [item.taskId, item]));

  for (const task of tasks) {
    const result = resultByTask.get(task.taskId);
    const status = result?.provenance.status ?? "failed";
    for (const fragment of task.fragments) {
      const record = ensureSpan(
        spans,
        fragment.field,
        fragment.paragraph_index,
        fragment.quoted_text,
      );
      if (!record.assigned.includes(task.specialist)) {
        record.assigned.push(task.specialist);
      }
      record.statuses[task.specialist] = status;
    }
    if (!result) {
      continue;
    }
    for (const candidate of result.candidates) {
      const record = ensureSpan(
        spans,
        candidate.source.field,
        candidate.source.paragraph_index,
        candidate.source.exact_quote,
      );
      if (!record.assigned.includes(task.specialist)) {
        record.assigned.push(task.specialist);
      }
      record.candidates[task.specialist] = candidate;
      record.statuses[task.specialist] = result.provenance.status;
    }
  }

  const judgments: SpecialistJudgment[] = [];
  for (const record of spans.values()) {
    const assigned = record.assigned;
    const statuses = assigned.map((id) => record.statuses[id] ?? "failed");
    const timedOut = statuses.some((status) => status === "timed_out");
    const failed = statuses.some((status) => status === "failed" || status === "not_invoked");
    const succeeded = assigned.filter((id) => record.statuses[id] === "succeeded");
    const successfulCandidates = succeeded
      .map((id) => record.candidates[id])
      .filter((item): item is ReviewCandidate => item != null);

    if (timedOut || failed) {
      const reason = timedOut
        ? assigned.length > 1 && succeeded.length > 0
          ? SPECIALIST_PARTIAL_FAILURE_MESSAGE
          : SPECIALIST_TIMEOUT_MESSAGE
        : assigned.length > 1 && succeeded.length > 0
          ? SPECIALIST_PARTIAL_FAILURE_MESSAGE
          : SPECIALIST_FAILURE_MESSAGE;
      judgments.push({
        field: record.field,
        paragraph_index: record.paragraph_index,
        quoted_text: record.quoted_text,
        decision: "verify",
        reason,
        specialist_ids: assigned,
        requires_verification: true,
      });
      continue;
    }

    if (successfulCandidates.length === 0) {
      continue;
    }

    if (succeeded.length > 1) {
      const allSpoke = successfulCandidates.length === succeeded.length;
      const agreed =
        allSpoke &&
        successfulCandidates.every((item) => sameConclusion(item, successfulCandidates[0]!));
      if (!agreed) {
        judgments.push({
          field: record.field,
          paragraph_index: record.paragraph_index,
          quoted_text: record.quoted_text,
          decision: "verify",
          reason: SPECIALIST_DISAGREEMENT_MESSAGE,
          specialist_ids: assigned,
          requires_verification: true,
        });
        continue;
      }
    }

    judgments.push({
      field: record.field,
      paragraph_index: record.paragraph_index,
      quoted_text: record.quoted_text,
      decision: "keep",
      reason: "多视角结论一致，或仅有单一相关视角成功返回。",
      specialist_ids: assigned,
      requires_verification: false,
    });
  }

  return judgments.sort((left, right) => {
    if (left.field !== right.field) {
      return left.field.localeCompare(right.field);
    }
    if (left.paragraph_index !== right.paragraph_index) {
      return left.paragraph_index - right.paragraph_index;
    }
    return left.quoted_text.localeCompare(right.quoted_text);
  });
}
