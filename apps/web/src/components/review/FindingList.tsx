"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { EvidenceItem, Finding, FindingAction, FindingStatus, Severity } from "@grc/contracts";
import { FINDING_TYPES, SEVERITIES } from "@grc/contracts";
import { sortFindingsForDisplay } from "@/lib/highlight-segments";
import { IconAlert, IconExternal, IconLocate, IconSealCheck } from "@/components/review/icons";

type FindingListProps = {
  findings: Finding[];
  selectedFindingId: string | null;
  pendingActionFindingId: string | null;
  revealNonce?: number;
  emptyTitle?: string;
  emptyDetail?: string;
  emptyCaution?: boolean;
  onSelectFinding: (findingId: string) => void;
  onDecide: (findingId: string, action: FindingAction) => void;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
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

const EVIDENCE_KIND_LABEL: Record<EvidenceItem["kind"], string> = {
  rule: "规则",
  internal_context: "文内对照",
  retrieved_source: "检索来源",
  ai_judgment: "模型判断",
};

const AUTHORITY_LABEL: Record<string, string> = {
  official: "官方来源",
  internal: "内部来源",
};

export function FindingList({
  findings,
  selectedFindingId,
  pendingActionFindingId,
  revealNonce = 0,
  emptyTitle = "未发现需要提示的问题",
  emptyDetail = "稿件已通过本轮自动审校，仍建议人工通读一遍。",
  emptyCaution = false,
  onSelectFinding,
  onDecide,
}: FindingListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [typeFilter, setTypeFilter] = useState<Finding["type"] | "all">("all");
  const ordered = useMemo(() => {
    return sortFindingsForDisplay(findings).filter((finding) => {
      if (severityFilter !== "all" && finding.severity !== severityFilter) {
        return false;
      }
      if (typeFilter !== "all" && finding.type !== typeFilter) {
        return false;
      }
      return true;
    });
  }, [findings, severityFilter, typeFilter]);

  useEffect(() => {
    if (!selectedFindingId) {
      return;
    }
    const root = listRef.current;
    if (!root) {
      return;
    }
    const target = root.querySelector<HTMLElement>(
      `[data-testid="finding-${cssEscape(selectedFindingId)}"]`,
    );
    if (!target) {
      return;
    }
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [selectedFindingId, revealNonce]);

  if (findings.length === 0) {
    return (
      <div
        data-testid="finding-empty"
        className={`finding-empty${emptyCaution ? " is-caution" : ""}`}
      >
        {emptyCaution ? <IconAlert /> : <IconSealCheck />}
        <strong>{emptyTitle}</strong>
        {emptyDetail}
      </div>
    );
  }

  return (
    <div ref={listRef} className="finding-list" data-testid="finding-list">
      <div className="finding-filters">
        <label className="filter-field">
          风险
          <select
            data-testid="severity-filter"
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as Severity | "all")}
          >
            <option value="all">全部</option>
            {SEVERITIES.map((item) => (
              <option key={item} value={item}>
                {SEVERITY_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          类型
          <select
            data-testid="type-filter"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as Finding["type"] | "all")}
          >
            <option value="all">全部</option>
            {FINDING_TYPES.map((item) => (
              <option key={item} value={item}>
                {TYPE_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <span className="filter-result">{ordered.length} 条</span>
      </div>
      {ordered.length === 0 ? (
        <div data-testid="finding-filter-empty" className="finding-empty">
          <strong>没有符合筛选条件的问题</strong>
          可调整风险或类型筛选条件。
        </div>
      ) : null}
      {ordered.map((finding, index) => {
        const selected = finding.finding_id === selectedFindingId;
        const pending = pendingActionFindingId === finding.finding_id;
        const canAct =
          (finding.status === "pending" || finding.status === "verify") && !pendingActionFindingId;
        const canAccept = canAct && finding.suggestion.replacement !== null;
        return (
          <article
            key={finding.finding_id}
            data-testid={`finding-${finding.finding_id}`}
            className={`finding-card ${selected ? "is-selected" : ""} status-${finding.status}`}
          >
            <div className="finding-card-meta">
              <span className="finding-index">{String(index + 1).padStart(2, "0")}</span>
              <span className={`severity-pill severity-${finding.severity}`}>
                {SEVERITY_LABEL[finding.severity]}
              </span>
              <span className="finding-type">{TYPE_LABEL[finding.type]}</span>
              <span className={`status-pill status-${finding.status}`}>
                {STATUS_LABEL[finding.status]}
              </span>
              <span className="finding-confidence">
                置信 {Math.round(finding.confidence * 100)}%
              </span>
            </div>
            <h2 className="finding-title">
              <button
                type="button"
                className="finding-locate"
                data-testid={`locate-${finding.finding_id}`}
                title="在正文中定位"
                onClick={() => onSelectFinding(finding.finding_id)}
              >
                <IconLocate />
                <span>{finding.title}</span>
              </button>
            </h2>
            <p className="finding-quote">
              <span className="quote-label">原文</span>
              {finding.source_span.quoted_text}
            </p>
            <p className="finding-reason">{finding.reason}</p>
            <p className="finding-suggestion">
              <span className="finding-label">建议</span>
              {finding.suggestion.text}
            </p>
            {finding.suggestion.replacement !== null ? (
              <p className="finding-replace">
                <span className="finding-label">改为</span>
                <span className="replace-new">{finding.suggestion.replacement}</span>
              </p>
            ) : (
              <p className="finding-unsafe" data-testid={`no-safe-replacement-${finding.finding_id}`}>
                <IconAlert />
                无安全自动替换，需人工核实
              </p>
            )}
            {finding.evidence.length > 0 ? (
              <div className="finding-evidence-list">
                {finding.evidence.map((item, evidenceIndex) => (
                  <p
                    key={`${finding.finding_id}-ev-${evidenceIndex}`}
                    className="finding-evidence"
                  >
                    <span className={`evidence-kind evidence-${item.kind}`}>
                      {EVIDENCE_KIND_LABEL[item.kind]}
                    </span>
                    {item.excerpt}
                    {item.source_name ||
                    item.authority_level ||
                    item.source_version_date ||
                    item.source_url ? (
                      <span className="evidence-meta">
                        {" — "}
                        {[
                          item.source_name,
                          item.authority_level
                            ? (AUTHORITY_LABEL[item.authority_level] ?? item.authority_level)
                            : null,
                          item.source_version_date,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        {item.source_url ? (
                          <>
                            {" · "}
                            <a href={item.source_url} target="_blank" rel="noreferrer">
                              查看来源
                              <IconExternal width={11} height={11} />
                            </a>
                          </>
                        ) : null}
                        {item.kind === "retrieved_source" && item.citation_validated
                          ? " · 引文已核验"
                          : ""}
                      </span>
                    ) : null}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="finding-actions">
              <button
                type="button"
                data-testid={`accept-${finding.finding_id}`}
                className="action-button action-accept"
                disabled={!canAccept}
                onClick={() => onDecide(finding.finding_id, "accept")}
              >
                {pending ? "处理中…" : "接受"}
              </button>
              <button
                type="button"
                data-testid={`ignore-${finding.finding_id}`}
                className="action-button action-ignore"
                disabled={!canAct}
                onClick={() => onDecide(finding.finding_id, "ignore")}
              >
                忽略
              </button>
              <button
                type="button"
                data-testid={`verify-${finding.finding_id}`}
                className="action-button action-verify"
                disabled={!canAct}
                onClick={() => onDecide(finding.finding_id, "verify")}
              >
                待核实
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
