import type {
  LlmEvidenceItem,
  ModelSpecialistId,
  ReviewCandidate,
  Specialist,
  SpecialistFragment,
  SpecialistPreliminaryFinding,
  SpecialistResult,
  SpecialistRetrievedEvidence,
  SpecialistRunOptions,
  SpecialistTask,
} from "@grc/contracts";
import { parseSpecialistResult } from "@grc/contracts";

import { FAKE_SPECIALIST_MODEL, FAKE_SPECIALIST_PROVIDER } from "./config";
import { SpecialistExecutionError } from "./errors";
import { isModelSpecialistId } from "./roles";

export type FakeSpecialistBehavior = "success" | "empty" | "timeout" | "failure";

export type FakeSpecialistOptions = {
  behavior?: FakeSpecialistBehavior;
  behaviorFor?: (task: SpecialistTask) => FakeSpecialistBehavior | undefined;
  extraCandidates?: readonly ReviewCandidate[];
  catalog?: Record<string, ReviewCandidate>;
};

function behaviorOf(task: SpecialistTask, options: FakeSpecialistOptions): FakeSpecialistBehavior {
  return options.behaviorFor?.(task) ?? options.behavior ?? "success";
}

function evidenceForFinding(
  finding: SpecialistPreliminaryFinding,
  fragment: SpecialistFragment,
  retrieved: readonly SpecialistRetrievedEvidence[],
): LlmEvidenceItem[] {
  const related = retrieved.filter(
    (item) =>
      fragment.quoted_text.includes(item.trigger) ||
      finding.title.includes(item.trigger) ||
      finding.reason.includes(item.trigger) ||
      item.excerpt.includes(fragment.quoted_text),
  );
  const items: LlmEvidenceItem[] = [
    {
      kind: "internal_context",
      excerpt: fragment.quoted_text,
      citation_validated: true,
    },
  ];
  for (const item of related) {
    items.push({
      kind: "retrieved_source",
      excerpt: item.excerpt,
      citation_validated: false,
      source_id: item.source_id,
      source_url: item.source_url,
    });
  }
  if (items.length === 1) {
    items.push({
      kind: "ai_judgment",
      excerpt: finding.reason,
      citation_validated: false,
    });
  }
  return items;
}

function candidateFromFinding(
  finding: SpecialistPreliminaryFinding,
  fragment: SpecialistFragment,
  retrieved: readonly SpecialistRetrievedEvidence[],
): ReviewCandidate {
  return {
    type: finding.type,
    severity: finding.severity,
    title: finding.title,
    reason: finding.reason,
    suggestion: finding.suggestion ?? { text: finding.reason, replacement: null },
    confidence: finding.confidence,
    evidence: evidenceForFinding(finding, fragment, retrieved),
    source: {
      field: fragment.field,
      exact_quote: fragment.quoted_text,
      paragraph_index: fragment.paragraph_index,
      context_before: fragment.context_before,
      context_after: fragment.context_after,
    },
  };
}

function catalogCandidate(
  catalog: Record<string, ReviewCandidate> | undefined,
  fragment: SpecialistFragment,
): ReviewCandidate | undefined {
  if (!catalog) {
    return undefined;
  }
  return catalog[fragment.quoted_text];
}

function sortCandidates(candidates: ReviewCandidate[]): ReviewCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.source.field !== right.source.field) {
      return left.source.field.localeCompare(right.source.field);
    }
    if (left.source.paragraph_index !== right.source.paragraph_index) {
      return left.source.paragraph_index - right.source.paragraph_index;
    }
    if (left.source.exact_quote !== right.source.exact_quote) {
      return left.source.exact_quote.localeCompare(right.source.exact_quote);
    }
    return left.title.localeCompare(right.title);
  });
}

function buildCandidates(task: SpecialistTask, options: FakeSpecialistOptions): ReviewCandidate[] {
  const echoed: ReviewCandidate[] = [];
  const seen = new Set<string>();
  for (const finding of task.preliminaryFindings) {
    const fragment =
      task.fragments.find(
        (item) =>
          item.field === finding.source_span.field &&
          item.start_offset === finding.source_span.start_offset &&
          item.end_offset === finding.source_span.end_offset,
      ) ??
      task.fragments.find(
        (item) =>
          item.field === finding.source_span.field &&
          item.quoted_text === finding.source_span.quoted_text,
      );
    if (!fragment) {
      continue;
    }
    const override = catalogCandidate(options.catalog, fragment);
    const candidate = override ?? candidateFromFinding(finding, fragment, task.retrievedEvidence);
    const key = `${candidate.source.field}:${candidate.source.paragraph_index}:${candidate.source.exact_quote}:${candidate.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    echoed.push(candidate);
  }
  for (const fragment of task.fragments) {
    const override = catalogCandidate(options.catalog, fragment);
    if (!override) {
      continue;
    }
    const key = `${override.source.field}:${override.source.paragraph_index}:${override.source.exact_quote}:${override.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    echoed.push(override);
  }
  const extras = options.extraCandidates ?? [];
  return sortCandidates([...echoed, ...extras]).slice(0, task.constraints.maxCandidates);
}

class FakeModelSpecialist implements Specialist {
  readonly provider = FAKE_SPECIALIST_PROVIDER;
  readonly model = FAKE_SPECIALIST_MODEL;

  constructor(
    readonly id: ModelSpecialistId,
    private readonly options: FakeSpecialistOptions = {},
  ) {}

  async run(task: SpecialistTask, options: SpecialistRunOptions = {}): Promise<SpecialistResult> {
    if (task.specialist !== this.id) {
      throw new SpecialistExecutionError(`task specialist ${task.specialist} does not match ${this.id}`);
    }
    if (task.article) {
      throw new SpecialistExecutionError(`${this.id} must not receive the full article`);
    }
    const started = Date.now();
    const behavior = behaviorOf(task, this.options);
    if (behavior === "timeout") {
      await new Promise<never>((_, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    if (behavior === "failure") {
      throw new SpecialistExecutionError(`${this.id} fake specialist failed`);
    }
    const candidates = behavior === "empty" ? [] : buildCandidates(task, this.options);
    return parseSpecialistResult({
      taskId: task.taskId,
      candidates,
      provenance: {
        taskId: task.taskId,
        specialist: this.id,
        invoked: true,
        status: "succeeded",
        provider: FAKE_SPECIALIST_PROVIDER,
        model: FAKE_SPECIALIST_MODEL,
        elapsedMs: Math.max(0, Date.now() - started),
      },
      warnings: [],
    });
  }
}

export class FakeFactCheckSpecialist extends FakeModelSpecialist {
  constructor(options: FakeSpecialistOptions = {}) {
    super("fact_check", options);
  }
}

export class FakeNewsEditSpecialist extends FakeModelSpecialist {
  constructor(options: FakeSpecialistOptions = {}) {
    super("news_edit", options);
  }
}

export function createFakeSpecialists(options: {
  factCheck?: FakeSpecialistOptions;
  newsEdit?: FakeSpecialistOptions;
} = {}): Specialist[] {
  return [
    new FakeFactCheckSpecialist(options.factCheck),
    new FakeNewsEditSpecialist(options.newsEdit),
  ];
}

export function createFakeSpecialist(
  id: ModelSpecialistId,
  options: FakeSpecialistOptions = {},
): Specialist {
  if (!isModelSpecialistId(id)) {
    throw new SpecialistExecutionError(`unsupported fake specialist ${id}`);
  }
  return id === "fact_check"
    ? new FakeFactCheckSpecialist(options)
    : new FakeNewsEditSpecialist(options);
}
