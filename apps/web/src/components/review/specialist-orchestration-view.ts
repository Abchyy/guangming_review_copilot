import type {
  ArticleField,
  FindingType,
  LlmEvidenceItem,
  ModelSpecialistId,
  ReviewCandidate,
  Severity,
  SpecialistExecutionStatus,
  SpecialistId,
  SpecialistJudgment,
  SpecialistOrchestrationRun,
  SpecialistSkip,
} from "@grc/contracts";
import { MODEL_SPECIALIST_IDS } from "@grc/contracts";

export const SPECIALIST_PANEL_TITLE = "专项核验";

export const SPECIALIST_DISABLED_MESSAGE =
  "本轮未启用专项核验，未调用事实核验或新闻编辑模型。";

export const SPECIALIST_ENABLED_MESSAGE =
  "本轮已启用专项核验。下列结果只作解释，不自动改稿。";

export const SPECIALIST_ENABLED_NOT_DISPATCHED_MESSAGE =
  "本轮已启用专项核验，但未派发事实核验或新闻编辑模型。";

export const SPECIALIST_EMPTY_CANDIDATES_MESSAGE = "无候选意见，不表示稿件没有问题。";

export const SPECIALIST_DISPLAY_TITLES: Record<ModelSpecialistId, string> = {
  fact_check: "事实核验",
  news_edit: "新闻编辑",
};

export const SPECIALIST_EXECUTION_STATUS_LABEL: Record<SpecialistExecutionStatus, string> = {
  not_invoked: "未调用",
  succeeded: "已返回",
  failed: "调用失败",
  timed_out: "调用超时",
};

export const SPECIALIST_FIELD_LABEL: Record<ArticleField, string> = {
  title: "标题",
  body: "正文",
};

export const SPECIALIST_TYPE_LABEL: Record<FindingType, string> = {
  basic_text: "基础文字",
  person: "人物",
  organization: "机构",
  datetime: "时间",
  number: "数字",
  policy: "政策表述",
  citation: "引用",
  consistency: "文内一致性",
  external_fact: "外部事实",
};

export const SPECIALIST_SEVERITY_LABEL: Record<Severity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};

export const SPECIALIST_EVIDENCE_KIND_LABEL: Record<LlmEvidenceItem["kind"], string> = {
  rule: "规则",
  internal_context: "文内对照",
  retrieved_source: "检索来源",
  ai_judgment: "模型判断",
};

const SKIP_REASON_LABEL: Record<string, string> = {
  "call budget": "超出调用预算，未派发",
  "specialist not registered": "未注册，未派发",
  deadline: "时间预算已用尽，未调用",
};

export type SpecialistCallView = {
  id: ModelSpecialistId;
  title: string;
  invoked: boolean;
  status: SpecialistExecutionStatus;
  statusLabel: string;
  skipReason: string | null;
  elapsedMs: number | null;
  provider: string | null;
  model: string | null;
  warnings: string[];
  candidates: ReviewCandidate[];
};

export type SpecialistFragmentView = {
  key: string;
  field: ArticleField;
  paragraph_index: number;
  quoted_text: string;
  context_before: string | null;
  context_after: string | null;
  specialist_ids: SpecialistId[];
};

export type SpecialistCandidateView = {
  key: string;
  specialist: ModelSpecialistId;
  specialistTitle: string;
  candidateIndex: number;
  candidate: ReviewCandidate;
};

export type SpecialistVerificationView = {
  key: string;
  field: ArticleField;
  paragraph_index: number;
  quoted_text: string;
  reason: string;
  specialist_ids: SpecialistId[];
};

export type SpecialistOrchestrationView = {
  enabled: boolean;
  summary: string;
  targetModel: string | null;
  budgetLabel: string | null;
  calls: SpecialistCallView[];
  fragments: SpecialistFragmentView[];
  candidates: SpecialistCandidateView[];
  verifications: SpecialistVerificationView[];
  warnings: string[];
};

function isModelSpecialistId(id: SpecialistId): id is ModelSpecialistId {
  return (MODEL_SPECIALIST_IDS as readonly string[]).includes(id);
}

function fragmentKey(field: ArticleField, paragraphIndex: number, quoted: string): string {
  return `${field}:${paragraphIndex}:${quoted}`;
}

function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? `未派发：${reason}`;
}

function skipFor(run: SpecialistOrchestrationRun, id: ModelSpecialistId): SpecialistSkip | undefined {
  return run.skipped.find((item) => item.specialist === id);
}

function resultFor(run: SpecialistOrchestrationRun, id: ModelSpecialistId) {
  return run.results.find((item) => item.provenance.specialist === id);
}

function disabledCall(id: ModelSpecialistId): SpecialistCallView {
  return {
    id,
    title: SPECIALIST_DISPLAY_TITLES[id],
    invoked: false,
    status: "not_invoked",
    statusLabel: SPECIALIST_EXECUTION_STATUS_LABEL.not_invoked,
    skipReason: null,
    elapsedMs: null,
    provider: null,
    model: null,
    warnings: [],
    candidates: [],
  };
}

function callView(run: SpecialistOrchestrationRun, id: ModelSpecialistId): SpecialistCallView {
  const result = resultFor(run, id);
  const skip = skipFor(run, id);
  if (!result) {
    return {
      ...disabledCall(id),
      skipReason: skip ? skipReasonLabel(skip.reason) : null,
    };
  }

  const invoked = result.provenance.invoked === true;
  const status = invoked ? result.provenance.status : "not_invoked";
  return {
    id,
    title: SPECIALIST_DISPLAY_TITLES[id],
    invoked,
    status,
    statusLabel: SPECIALIST_EXECUTION_STATUS_LABEL[status],
    skipReason: invoked ? null : skip ? skipReasonLabel(skip.reason) : null,
    elapsedMs: invoked ? result.provenance.elapsedMs : null,
    provider: invoked ? result.provenance.provider : null,
    model: invoked ? result.provenance.model : null,
    warnings: result.warnings,
    candidates: invoked ? result.candidates : [],
  };
}

function collectFragments(
  run: SpecialistOrchestrationRun,
  calls: readonly SpecialistCallView[],
): SpecialistFragmentView[] {
  const fragments = new Map<string, SpecialistFragmentView>();

  function ensure(
    field: ArticleField,
    paragraphIndex: number,
    quoted: string,
    specialist: SpecialistId,
    contextBefore: string | null = null,
    contextAfter: string | null = null,
  ) {
    const key = fragmentKey(field, paragraphIndex, quoted);
    const existing = fragments.get(key);
    if (existing) {
      if (!existing.specialist_ids.includes(specialist)) {
        existing.specialist_ids.push(specialist);
      }
      if (!existing.context_before && contextBefore) {
        existing.context_before = contextBefore;
      }
      if (!existing.context_after && contextAfter) {
        existing.context_after = contextAfter;
      }
      return;
    }
    fragments.set(key, {
      key,
      field,
      paragraph_index: paragraphIndex,
      quoted_text: quoted,
      context_before: contextBefore,
      context_after: contextAfter,
      specialist_ids: [specialist],
    });
  }

  for (const call of calls) {
    if (!call.invoked) {
      continue;
    }
    for (const candidate of call.candidates) {
      ensure(
        candidate.source.field,
        candidate.source.paragraph_index,
        candidate.source.exact_quote,
        call.id,
        candidate.source.context_before,
        candidate.source.context_after,
      );
    }
  }

  for (const judgment of run.judgments) {
    for (const specialist of judgment.specialist_ids) {
      ensure(
        judgment.field,
        judgment.paragraph_index,
        judgment.quoted_text,
        specialist,
      );
    }
  }

  return [...fragments.values()].sort((left, right) => {
    if (left.field !== right.field) {
      return left.field.localeCompare(right.field);
    }
    if (left.paragraph_index !== right.paragraph_index) {
      return left.paragraph_index - right.paragraph_index;
    }
    return left.quoted_text.localeCompare(right.quoted_text);
  });
}

function collectCandidates(calls: readonly SpecialistCallView[]): SpecialistCandidateView[] {
  const items: SpecialistCandidateView[] = [];
  for (const call of calls) {
    if (!call.invoked) {
      continue;
    }
    call.candidates.forEach((candidate, index) => {
      items.push({
        key: `${call.id}:${index}`,
        specialist: call.id,
        specialistTitle: call.title,
        candidateIndex: index,
        candidate,
      });
    });
  }
  return items;
}

function isVerification(judgment: SpecialistJudgment): boolean {
  return judgment.decision === "verify" || judgment.requires_verification;
}

function collectVerifications(run: SpecialistOrchestrationRun): SpecialistVerificationView[] {
  return run.judgments.filter(isVerification).map((judgment, index) => ({
    key: `${judgment.field}:${judgment.paragraph_index}:${judgment.quoted_text}:${index}`,
    field: judgment.field,
    paragraph_index: judgment.paragraph_index,
    quoted_text: judgment.quoted_text,
    reason: judgment.reason,
    specialist_ids: judgment.specialist_ids,
  }));
}

function enabledSummary(run: SpecialistOrchestrationRun, calls: readonly SpecialistCallView[]): string {
  const dispatched = calls.some((item) => item.invoked || run.dispatched.includes(item.id));
  if (!dispatched && run.dispatched.length === 0) {
    return SPECIALIST_ENABLED_NOT_DISPATCHED_MESSAGE;
  }
  return SPECIALIST_ENABLED_MESSAGE;
}

export function specialistDisplayTitle(id: SpecialistId): string {
  if (isModelSpecialistId(id)) {
    return SPECIALIST_DISPLAY_TITLES[id];
  }
  return id;
}

export function specialistOrchestrationView(
  run: SpecialistOrchestrationRun | null | undefined,
): SpecialistOrchestrationView {
  if (!run || run.enabled !== true) {
    return {
      enabled: false,
      summary: SPECIALIST_DISABLED_MESSAGE,
      targetModel: null,
      budgetLabel: null,
      calls: MODEL_SPECIALIST_IDS.map(disabledCall),
      fragments: [],
      candidates: [],
      verifications: [],
      warnings: [],
    };
  }

  const calls = MODEL_SPECIALIST_IDS.map((id) => callView(run, id));
  const invoked = calls.some((item) => item.invoked);
  return {
    enabled: true,
    summary: enabledSummary(run, calls),
    targetModel: invoked ? run.target_model : null,
    budgetLabel: `派发 ${run.budget.used} / ${run.budget.max_specialists}`,
    calls,
    fragments: collectFragments(run, calls),
    candidates: collectCandidates(calls),
    verifications: collectVerifications(run),
    warnings: run.warnings,
  };
}

export function hasPendingSpecialistVerification(
  run: SpecialistOrchestrationRun | null | undefined,
): boolean {
  return specialistOrchestrationView(run).verifications.length > 0;
}

export function specialistHasEmptyInvokedCandidates(view: SpecialistOrchestrationView): boolean {
  return (
    view.enabled &&
    view.calls.some((item) => item.invoked && item.status === "succeeded") &&
    view.candidates.length === 0
  );
}
