import type {
  LlmEvidenceItem,
  ModelSpecialistId,
  ReviewCandidate,
  ReviewExecutionProvenance,
  ReviewProvider,
  Specialist,
  SpecialistFragment,
  SpecialistResult,
  SpecialistRunOptions,
  SpecialistTask,
  SpecialistWebEvidenceItem,
} from "@grc/contracts";
import {
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_TIMEOUT_MESSAGE,
  parseSpecialistResult,
  specialistCallTrace,
} from "@grc/contracts";

import {
  SPECIALIST_MAX_ATTEMPTS,
  SPECIALIST_MAX_TOKENS,
  SPECIALIST_REQUEST_TIMEOUT_MS,
  SPECIALIST_SDK_MAX_RETRIES,
} from "./config";
import { SpecialistExecutionError } from "./errors";
import { SPECIALIST_ROLE_FINDING_TYPES, SPECIALIST_ROLE_PROMPTS, isModelSpecialistId } from "./roles";

export type SpecialistCompletionInput = {
  system: string;
  user: string;
  signal?: AbortSignal;
  maxTokens?: number;
  maxAttempts?: number;
  maxRetries?: number;
  timeoutMs?: number;
};

export type SpecialistCompletionClient = {
  readonly provider: ReviewProvider;
  readonly model: string | null;
  completeJson(input: SpecialistCompletionInput): Promise<ReviewCandidate[]>;
  consumeLastProvenance?(): ReviewExecutionProvenance | null;
};

export function buildSpecialistUserPrompt(task: SpecialistTask): string {
  const parts = [
    "请只根据下列片段、初步 findings 和已有证据做专项核验。你没有全文，不得假设未给出的上下文，不得检索外部网页。",
    "",
    "【片段】",
  ];
  if (task.fragments.length === 0) {
    parts.push("无。");
  } else {
    for (const fragment of task.fragments) {
      parts.push(
        `- field=${fragment.field}; paragraph=${fragment.paragraph_index}; quote=${fragment.quoted_text}; context_before=${fragment.context_before ?? "null"}; context_after=${fragment.context_after ?? "null"}`,
      );
    }
  }

  parts.push("", "【初步 findings】");
  if (task.preliminaryFindings.length === 0) {
    parts.push("无。");
  } else {
    for (const finding of task.preliminaryFindings) {
      parts.push(
        `- type=${finding.type}; severity=${finding.severity}; title=${finding.title}; reason=${finding.reason}; quote=${finding.source_span.quoted_text}`,
      );
    }
  }

  parts.push("", "【本地检索证据】");
  if (task.retrievedEvidence.length === 0) {
    parts.push("无。不得编造 retrieved_source 或 source_id。");
  } else {
    for (const item of task.retrievedEvidence) {
      parts.push(
        `- source_id=${item.source_id}; source_name=${item.source_name}; excerpt=${item.excerpt}`,
      );
    }
  }

  parts.push("", "【已有联网证据】");
  const webEvidence = task.webEvidence ?? [];
  if (webEvidence.length === 0) {
    parts.push("无。不得编造联网结果或 URL。");
  } else {
    for (const item of webEvidence) {
      parts.push(formatWebEvidence(item));
    }
  }

  parts.push(
    "",
    `约束：allowExternalRetrieval=${String(task.constraints.allowExternalRetrieval)}；maxCandidates=${String(task.constraints.maxCandidates)}。`,
    "只输出符合 schema 的 json 对象，键名为 candidates。exact_quote 必须从上述片段精确复制。",
  );
  return parts.join("\n");
}

function formatWebEvidence(item: SpecialistWebEvidenceItem): string {
  return `- source_name=${item.source_name}; url=${item.url}; excerpt=${item.excerpt}`;
}

function allowedSourceIds(task: SpecialistTask): Set<string> {
  return new Set(task.retrievedEvidence.map((item) => item.source_id));
}

function allowedSourceUrls(task: SpecialistTask): Set<string> {
  return new Set([
    ...task.retrievedEvidence.map((item) => item.source_url),
    ...(task.webEvidence ?? []).map((item) => item.url),
  ]);
}

function fragmentWindow(fragment: SpecialistFragment): string {
  return `${fragment.context_before ?? ""}${fragment.quoted_text}${fragment.context_after ?? ""}`;
}

export function matchingTaskFragment(
  candidate: Pick<ReviewCandidate, "source">,
  fragments: readonly SpecialistFragment[],
): SpecialistFragment | undefined {
  const quote = candidate.source.exact_quote;
  if (quote.length === 0) {
    return undefined;
  }
  return fragments.find(
    (fragment) =>
      fragment.field === candidate.source.field &&
      fragment.paragraph_index === candidate.source.paragraph_index &&
      (fragment.quoted_text === quote || fragment.quoted_text.includes(quote)),
  );
}

export function candidateQuoteFromTaskFragments(
  candidate: Pick<ReviewCandidate, "source">,
  fragments: readonly SpecialistFragment[],
): boolean {
  return matchingTaskFragment(candidate, fragments) != null;
}

function excerptInTaskFragments(
  excerpt: string,
  fragments: readonly SpecialistFragment[],
): boolean {
  if (excerpt.length === 0) {
    return false;
  }
  return fragments.some(
    (fragment) =>
      fragment.quoted_text.includes(excerpt) || fragmentWindow(fragment).includes(excerpt),
  );
}

function sanitizeEvidenceItem(
  item: LlmEvidenceItem,
  allowedIds: Set<string>,
  allowedUrls: Set<string>,
  fragments: readonly SpecialistFragment[],
): LlmEvidenceItem | null {
  const source_id = item.source_id && allowedIds.has(item.source_id) ? item.source_id : undefined;
  const source_url = item.source_url && allowedUrls.has(item.source_url) ? item.source_url : undefined;
  if (item.kind === "retrieved_source" && source_id == null && source_url == null) {
    return null;
  }
  if (item.kind === "rule") {
    return {
      kind: "ai_judgment",
      excerpt: item.excerpt,
      citation_validated: false,
    };
  }
  if (item.kind === "internal_context" && !excerptInTaskFragments(item.excerpt, fragments)) {
    return {
      kind: "ai_judgment",
      excerpt: item.excerpt,
      citation_validated: false,
    };
  }
  const sanitized: LlmEvidenceItem = {
    kind: item.kind,
    excerpt: item.excerpt,
    citation_validated: item.kind === "internal_context" ? true : item.citation_validated,
  };
  if (source_id) {
    sanitized.source_id = source_id;
  }
  if (source_url) {
    sanitized.source_url = source_url;
  }
  return sanitized;
}

export function sanitizeSpecialistCandidates(
  specialist: ModelSpecialistId,
  task: SpecialistTask,
  candidates: readonly ReviewCandidate[],
): ReviewCandidate[] {
  const allowedTypes = new Set(SPECIALIST_ROLE_FINDING_TYPES[specialist]);
  const allowedIds = allowedSourceIds(task);
  const allowedUrls = allowedSourceUrls(task);
  const sanitized: ReviewCandidate[] = [];
  for (const candidate of candidates) {
    if (!allowedTypes.has(candidate.type) || candidate.type === "basic_text") {
      continue;
    }
    const fragment = matchingTaskFragment(candidate, task.fragments);
    if (!fragment) {
      continue;
    }
    const evidence = candidate.evidence
      .map((item) => sanitizeEvidenceItem(item, allowedIds, allowedUrls, task.fragments))
      .filter((item): item is LlmEvidenceItem => item != null);
    const next: ReviewCandidate = {
      type: candidate.type,
      severity: candidate.severity,
      title: candidate.title,
      reason: candidate.reason,
      suggestion: candidate.suggestion,
      confidence: candidate.confidence,
      evidence:
        evidence.length > 0
          ? evidence
          : [
              {
                kind: "ai_judgment",
                excerpt: candidate.reason,
                citation_validated: false,
              },
            ],
      source: {
        field: fragment.field,
        exact_quote: candidate.source.exact_quote,
        paragraph_index: fragment.paragraph_index,
        context_before: fragment.context_before,
        context_after: fragment.context_after,
      },
    };
    if (candidate.source_id && allowedIds.has(candidate.source_id)) {
      next.source_id = candidate.source_id;
    }
    sanitized.push(next);
  }
  return sanitized.slice(0, task.constraints.maxCandidates);
}

export class ModelSpecialist implements Specialist {
  readonly provider: ReviewProvider;
  readonly model: string | null;

  constructor(
    readonly id: ModelSpecialistId,
    private readonly client: SpecialistCompletionClient,
  ) {
    this.provider = client.provider;
    this.model = client.model;
  }

  async run(task: SpecialistTask, options: SpecialistRunOptions = {}): Promise<SpecialistResult> {
    if (task.specialist !== this.id) {
      throw new SpecialistExecutionError(`task specialist ${task.specialist} does not match ${this.id}`);
    }
    if (task.article) {
      throw new SpecialistExecutionError(`${this.id} must not receive the full article`);
    }
    if (task.constraints.allowExternalRetrieval) {
      throw new SpecialistExecutionError(`${this.id} must not retrieve externally`);
    }
    const started = Date.now();
    const allowedTypes = new Set(SPECIALIST_ROLE_FINDING_TYPES[this.id]);
    const promptTask: SpecialistTask = {
      ...task,
      preliminaryFindings: task.preliminaryFindings.filter((item) => allowedTypes.has(item.type)),
    };
    const user = buildSpecialistUserPrompt(promptTask);
    try {
      const raw = await this.client.completeJson({
        system: SPECIALIST_ROLE_PROMPTS[this.id],
        user,
        signal: options.signal,
        maxTokens: SPECIALIST_MAX_TOKENS,
        maxAttempts: SPECIALIST_MAX_ATTEMPTS,
        maxRetries: SPECIALIST_SDK_MAX_RETRIES,
        timeoutMs: SPECIALIST_REQUEST_TIMEOUT_MS,
      });
      const execution = this.client.consumeLastProvenance?.() ?? null;
      const candidates = sanitizeSpecialistCandidates(this.id, task, raw);
      return parseSpecialistResult({
        taskId: task.taskId,
        candidates,
        provenance: {
          taskId: task.taskId,
          specialist: this.id,
          invoked: true,
          status: "succeeded",
          provider: this.provider,
          model: this.model,
          elapsedMs: Math.max(0, Date.now() - started),
          ...specialistCallTrace(execution),
        },
        warnings: [],
      });
    } catch (error) {
      const execution = this.client.consumeLastProvenance?.() ?? null;
      const timedOut = options.signal?.aborted === true || isAbortLike(error);
      return parseSpecialistResult({
        taskId: task.taskId,
        candidates: [],
        provenance: {
          taskId: task.taskId,
          specialist: this.id,
          invoked: true,
          status: timedOut ? "timed_out" : "failed",
          provider: this.provider,
          model: this.model,
          elapsedMs: Math.max(0, Date.now() - started),
          ...specialistCallTrace(execution),
        },
        warnings: [timedOut ? SPECIALIST_TIMEOUT_MESSAGE : messageOf(error)],
      });
    }
  }
}

function isAbortLike(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = String((error as { name?: unknown }).name);
    if (name === "AbortError" || name === "TimeoutError" || name === "APIUserAbortError") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|timed out|timeout/i.test(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : SPECIALIST_FAILURE_MESSAGE;
}

export function createModelSpecialists(
  clientFactory: () => SpecialistCompletionClient,
): Specialist[] {
  return [
    new ModelSpecialist("fact_check", clientFactory()),
    new ModelSpecialist("news_edit", clientFactory()),
  ];
}

export function createModelSpecialist(
  id: ModelSpecialistId,
  client: SpecialistCompletionClient,
): Specialist {
  if (!isModelSpecialistId(id)) {
    throw new SpecialistExecutionError(`unsupported model specialist ${id}`);
  }
  return new ModelSpecialist(id, client);
}
