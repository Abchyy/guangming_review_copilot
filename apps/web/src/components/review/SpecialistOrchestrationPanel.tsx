"use client";

import type { ReactNode } from "react";

import type { LlmEvidenceItem, ModelSpecialistId, SpecialistOrchestrationRun } from "@grc/contracts";
import { IconAlert, IconExternal } from "@/components/review/icons";
import {
  SPECIALIST_EMPTY_CANDIDATES_MESSAGE,
  SPECIALIST_EVIDENCE_KIND_LABEL,
  SPECIALIST_FIELD_LABEL,
  SPECIALIST_PANEL_TITLE,
  SPECIALIST_SEVERITY_LABEL,
  SPECIALIST_TYPE_LABEL,
  hasPendingSpecialistVerification,
  specialistDisplayTitle,
  specialistHasEmptyInvokedCandidates,
  specialistOrchestrationView,
  type SpecialistCallView,
  type SpecialistCandidateView,
  type SpecialistFragmentView,
  type SpecialistVerificationView,
} from "@/components/review/specialist-orchestration-view";

type SpecialistOrchestrationPanelProps = {
  run?: SpecialistOrchestrationRun | null;
};

export { hasPendingSpecialistVerification, specialistOrchestrationView };

export function SpecialistOrchestrationPanel({ run }: SpecialistOrchestrationPanelProps) {
  const view = specialistOrchestrationView(run);
  const needsVerification = view.verifications.length > 0;
  const emptyInvoked = specialistHasEmptyInvokedCandidates(view);

  return (
    <section
      className={`specialist-orchestration-panel${needsVerification ? " is-verify" : ""}${
        view.enabled ? "" : " is-disabled"
      }`}
      data-testid="specialist-orchestration-panel"
      data-enabled={view.enabled ? "true" : "false"}
      aria-label={SPECIALIST_PANEL_TITLE}
    >
      <header className="specialist-orchestration-head">
        <h3 className="specialist-orchestration-title">{SPECIALIST_PANEL_TITLE}</h3>
        <span
          className={`specialist-orchestration-status-pill ${
            view.enabled ? "status-enabled" : "status-disabled"
          }`}
          data-testid="specialist-orchestration-enabled"
        >
          {view.enabled ? "已启用" : "未启用"}
        </span>
      </header>
      <p className="specialist-orchestration-summary" data-testid="specialist-orchestration-summary">
        {view.summary}
      </p>
      {view.budgetLabel || view.targetModel ? (
        <p className="specialist-orchestration-meta">
          {view.budgetLabel}
          {view.budgetLabel && view.targetModel ? " · " : null}
          {view.targetModel ? `目标模型 ${view.targetModel}` : null}
        </p>
      ) : null}
      <ul className="specialist-call-list">
        {view.calls.map((call) => (
          <SpecialistCallStatus key={call.id} call={call} />
        ))}
      </ul>
      {view.fragments.length > 0 ? (
        <section className="specialist-section" aria-label="审校片段">
          <h4 className="specialist-section-title">审校片段</h4>
          {view.fragments.map((fragment, index) => (
            <SpecialistFragmentCard key={fragment.key} fragment={fragment} index={index} />
          ))}
        </section>
      ) : null}
      {view.candidates.length > 0 ? (
        <section className="specialist-section" aria-label="候选意见">
          <h4 className="specialist-section-title">候选意见</h4>
          {view.candidates.map((item) => (
            <SpecialistCandidateCard key={item.key} item={item} />
          ))}
        </section>
      ) : emptyInvoked ? (
        <p className="specialist-orchestration-empty" data-testid="specialist-empty-candidates">
          {SPECIALIST_EMPTY_CANDIDATES_MESSAGE}
        </p>
      ) : null}
      {view.verifications.length > 0 ? (
        <section className="specialist-section" aria-label="待人工核实">
          <h4 className="specialist-section-title">待人工核实</h4>
          {view.verifications.map((item, index) => (
            <SpecialistVerificationCard key={item.key} item={item} index={index} />
          ))}
        </section>
      ) : null}
    </section>
  );
}

function SpecialistCallStatus({ call }: { call: SpecialistCallView }) {
  return (
    <li
      className={`specialist-call status-${call.status}${call.invoked ? " is-invoked" : " is-idle"}`}
      data-testid={`specialist-call-${call.id}`}
      data-specialist={call.id}
      data-invoked={call.invoked ? "true" : "false"}
      data-status={call.status}
    >
      <div className="specialist-call-head">
        <span className="specialist-call-title">{call.title}</span>
        <span className={`specialist-orchestration-status-pill status-${call.status}`}>
          {call.statusLabel}
        </span>
      </div>
      {call.skipReason ? <p className="specialist-call-skip">{call.skipReason}</p> : null}
      {call.invoked && call.elapsedMs !== null ? (
        <p className="specialist-call-elapsed">{Math.round(call.elapsedMs)} ms</p>
      ) : null}
    </li>
  );
}

function SpecialistFragmentCard({
  fragment,
  index,
}: {
  fragment: SpecialistFragmentView;
  index: number;
}) {
  return (
    <article className="specialist-fragment" data-testid={`specialist-fragment-${index}`}>
      <p className="specialist-quote">
        <span className="quote-label">原文</span>
        {fragment.quoted_text}
      </p>
      <dl className="specialist-fields">
        <SpecialistField label="位置">
          {SPECIALIST_FIELD_LABEL[fragment.field]} · 第 {fragment.paragraph_index + 1} 段
        </SpecialistField>
        {fragment.context_before ? (
          <SpecialistField label="上文">{fragment.context_before}</SpecialistField>
        ) : null}
        {fragment.context_after ? (
          <SpecialistField label="下文">{fragment.context_after}</SpecialistField>
        ) : null}
        <SpecialistField label="视角">
          {fragment.specialist_ids.map(specialistDisplayTitle).join(" · ")}
        </SpecialistField>
      </dl>
    </article>
  );
}

function SpecialistCandidateCard({ item }: { item: SpecialistCandidateView }) {
  const { candidate, specialist, specialistTitle, candidateIndex } = item;
  return (
    <article
      className="specialist-candidate"
      data-testid={`specialist-candidate-${specialist}-${candidateIndex}`}
    >
      <div className="specialist-candidate-meta">
        <span className="specialist-call-title">{specialistTitle}</span>
        <span className={`severity-pill severity-${candidate.severity}`}>
          {SPECIALIST_SEVERITY_LABEL[candidate.severity]}
        </span>
        <span className="finding-type">{SPECIALIST_TYPE_LABEL[candidate.type]}</span>
        <span className="finding-confidence">
          置信 {Math.round(candidate.confidence * 100)}%
        </span>
      </div>
      <h5 className="specialist-candidate-title">{candidate.title}</h5>
      <p className="specialist-quote">
        <span className="quote-label">原文</span>
        {candidate.source.exact_quote}
      </p>
      <p className="finding-reason">{candidate.reason}</p>
      <p className="finding-suggestion">
        <span className="finding-label">建议</span>
        {candidate.suggestion.text}
      </p>
      {candidate.suggestion.replacement !== null ? (
        <p className="finding-replace">
          <span className="finding-label">改为</span>
          <span className="replace-new">{candidate.suggestion.replacement}</span>
        </p>
      ) : (
        <p className="finding-unsafe">
          <IconAlert />
          无安全自动替换，需人工核实
        </p>
      )}
      {candidate.evidence.length > 0 ? (
        <div className="specialist-evidence-list">
          <h6 className="specialist-evidence-heading">证据</h6>
          {candidate.evidence.map((evidence, evidenceIndex) => (
            <SpecialistEvidenceItem
              key={`${item.key}-ev-${evidenceIndex}`}
              evidence={evidence}
              specialist={specialist}
              candidateIndex={candidateIndex}
              evidenceIndex={evidenceIndex}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function SpecialistEvidenceItem({
  evidence,
  specialist,
  candidateIndex,
  evidenceIndex,
}: {
  evidence: LlmEvidenceItem;
  specialist: ModelSpecialistId;
  candidateIndex: number;
  evidenceIndex: number;
}) {
  return (
    <p
      className="finding-evidence"
      data-testid={`specialist-evidence-${specialist}-${candidateIndex}-${evidenceIndex}`}
    >
      <span className={`evidence-kind evidence-${evidence.kind}`}>
        {SPECIALIST_EVIDENCE_KIND_LABEL[evidence.kind]}
      </span>
      {evidence.excerpt}
      {evidence.source_url ? (
        <span className="evidence-meta">
          {" · "}
          <a href={evidence.source_url} target="_blank" rel="noreferrer">
            查看来源
            <IconExternal width={11} height={11} />
          </a>
        </span>
      ) : null}
    </p>
  );
}

function SpecialistVerificationCard({
  item,
  index,
}: {
  item: SpecialistVerificationView;
  index: number;
}) {
  return (
    <article className="specialist-verify" data-testid={`specialist-verify-${index}`}>
      <p className="specialist-verify-reason" role="status">
        <IconAlert />
        <span>{item.reason}</span>
      </p>
      <p className="specialist-quote">
        <span className="quote-label">原文</span>
        {item.quoted_text}
      </p>
      <dl className="specialist-fields">
        <SpecialistField label="位置">
          {SPECIALIST_FIELD_LABEL[item.field]} · 第 {item.paragraph_index + 1} 段
        </SpecialistField>
        <SpecialistField label="视角">
          {item.specialist_ids.map(specialistDisplayTitle).join(" · ")}
        </SpecialistField>
      </dl>
    </article>
  );
}

function SpecialistField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="specialist-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
