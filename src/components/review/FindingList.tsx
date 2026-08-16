"use client";

import type { Finding, Severity } from "@/lib/contracts/review";
import { sortFindingsForDisplay } from "@/lib/highlight-segments";

type FindingListProps = {
  findings: Finding[];
  selectedFindingId: string | null;
  onSelectFinding: (findingId: string) => void;
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

export function FindingList({
  findings,
  selectedFindingId,
  onSelectFinding,
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
        return (
          <button
            key={finding.finding_id}
            type="button"
            data-testid={`finding-${finding.finding_id}`}
            className={`finding-card ${selected ? "is-selected" : ""}`}
            onClick={() => onSelectFinding(finding.finding_id)}
          >
            <div className="finding-card-meta">
              <span className={`severity-pill severity-${finding.severity}`}>
                {SEVERITY_LABEL[finding.severity]}
              </span>
              <span className="finding-type">{TYPE_LABEL[finding.type]}</span>
              <span className="finding-confidence">
                {Math.round(finding.confidence * 100)}%
              </span>
            </div>
            <h2 className="finding-title">{finding.title}</h2>
            <p className="finding-reason">{finding.reason}</p>
            {finding.suggestion ? (
              <p className="finding-suggestion">
                建议：{finding.suggestion}
              </p>
            ) : (
              <p className="finding-suggestion">建议：需人工核实，不宜直接替换。</p>
            )}
            <p className="finding-evidence">
              依据[{finding.evidence.type}]：{finding.evidence.summary}
            </p>
            <p className="finding-quote">原文：{finding.source_span.quoted_text}</p>
          </button>
        );
      })}
    </div>
  );
}
