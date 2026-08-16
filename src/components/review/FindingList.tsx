"use client";

import type { Finding, FindingAction, FindingStatus, Severity } from "@/lib/contracts/review";
import { sortFindingsForDisplay } from "@/lib/highlight-segments";

type FindingListProps = {
  findings: Finding[];
  selectedFindingId: string | null;
  pendingActionFindingId: string | null;
  onSelectFinding: (findingId: string) => void;
  onDecide: (findingId: string, action: FindingAction) => void;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const TYPE_LABEL: Record<Finding["type"], string> = {
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

const STATUS_LABEL: Record<FindingStatus, string> = {
  pending: "待处理",
  accepted: "已接受",
  ignored: "已忽略",
  verify: "待人工核实",
  invalidated: "已失效",
};

export function FindingList({
  findings,
  selectedFindingId,
  pendingActionFindingId,
  onSelectFinding,
  onDecide,
}: FindingListProps) {
  const ordered = sortFindingsForDisplay(findings);

  if (ordered.length === 0) {
    return (
      <div data-testid="finding-empty" className="finding-empty">
        未发现需要提示的问题。
      </div>
    );
  }

  return (
    <div className="finding-list" data-testid="finding-list">
      {ordered.map((finding) => {
        const selected = finding.finding_id === selectedFindingId;
        const pending = pendingActionFindingId === finding.finding_id;
        const canAct =
          (finding.status === "pending" || finding.status === "verify") && !pendingActionFindingId;
        const canAccept = canAct && finding.suggestion.replacement !== null;
        return (
          <div
            key={finding.finding_id}
            data-testid={`finding-${finding.finding_id}`}
            className={`finding-card ${selected ? "is-selected" : ""} status-${finding.status}`}
            onClick={() => onSelectFinding(finding.finding_id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectFinding(finding.finding_id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="finding-card-select">
              <div className="finding-card-meta">
                <span className={`severity-pill severity-${finding.severity}`}>
                  {SEVERITY_LABEL[finding.severity]}
                </span>
                <span className="finding-type">{TYPE_LABEL[finding.type]}</span>
                <span className={`status-pill status-${finding.status}`}>
                  {STATUS_LABEL[finding.status]}
                </span>
                <span className="finding-confidence">
                  {Math.round(finding.confidence * 100)}%
                </span>
              </div>
              <h2 className="finding-title">{finding.title}</h2>
              <p className="finding-reason">{finding.reason}</p>
              <p className="finding-suggestion">建议：{finding.suggestion.text}</p>
              {finding.suggestion.replacement ? (
                <p className="finding-quote">替换为：{finding.suggestion.replacement}</p>
              ) : (
                <p className="finding-unsafe" data-testid={`no-safe-replacement-${finding.finding_id}`}>
                  建议人工核实，无安全自动替换。
                </p>
              )}
              {finding.evidence.map((item, index) => (
                <p key={`${finding.finding_id}-ev-${index}`} className="finding-evidence">
                  依据[{item.kind}]：{item.excerpt}
                </p>
              ))}
              <p className="finding-quote">原文：{finding.source_span.quoted_text}</p>
            </div>
            <div
              className="finding-actions"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                data-testid={`accept-${finding.finding_id}`}
                className="action-button"
                disabled={!canAccept}
                onClick={() => onDecide(finding.finding_id, "accept")}
              >
                {pending ? "处理中…" : "Accept"}
              </button>
              <button
                type="button"
                data-testid={`ignore-${finding.finding_id}`}
                className="action-button"
                disabled={!canAct}
                onClick={() => onDecide(finding.finding_id, "ignore")}
              >
                Ignore
              </button>
              <button
                type="button"
                data-testid={`verify-${finding.finding_id}`}
                className="action-button"
                disabled={!canAct}
                onClick={() => onDecide(finding.finding_id, "verify")}
              >
                Verify
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
