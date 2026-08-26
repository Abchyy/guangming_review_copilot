"use client";

import type {
  WebEvidenceFactCategory,
  WebEvidenceItem,
  WebEvidenceResult,
  WebEvidenceRun,
  WebEvidenceSourceTier,
  WebEvidenceStatus,
} from "@grc/contracts";
import { WEB_EVIDENCE_UNVERIFIED_MESSAGE } from "@grc/contracts";
import { IconAlert, IconExternal } from "@/components/review/icons";

type WebEvidencePanelProps = {
  run: WebEvidenceRun;
};

const STATUS_LABEL: Record<WebEvidenceStatus, string> = {
  retrieved: "已返回网页证据",
  unverified: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
};

const TIER_LABEL: Record<WebEvidenceSourceTier, string> = {
  official: "官方",
  authoritative: "权威",
  secondary: "次级",
  unknown: "未知",
};

const CATEGORY_LABEL: Record<WebEvidenceFactCategory, string> = {
  person_title: "人物职务",
  organization_name: "机构名称",
  policy_regulation: "政策法规",
  date: "日期",
  number: "数字",
  attribution: "归因",
};

export function hasUnverifiedWebEvidence(run: WebEvidenceRun | undefined): boolean {
  return Boolean(run?.results.some((item) => item.status === "unverified"));
}

export function WebEvidencePanel({ run }: WebEvidencePanelProps) {
  if (!run.enabled || run.results.length === 0) {
    return null;
  }

  const unverified = hasUnverifiedWebEvidence(run);

  return (
    <section
      className={`web-evidence-panel${unverified ? " is-unverified" : ""}`}
      data-testid="web-evidence-panel"
      aria-label="网页证据"
    >
      <header className="web-evidence-head">
        <h3 className="web-evidence-title">网页证据</h3>
        <span
          className={`web-evidence-status-pill status-${unverified ? "unverified" : "retrieved"}`}
          data-testid="web-evidence-status"
        >
          {unverified ? WEB_EVIDENCE_UNVERIFIED_MESSAGE : "已返回网页证据"}
        </span>
      </header>
      {run.results.map((result, index) => (
        <WebEvidenceResultCard key={`${result.provenance.query_text}-${index}`} result={result} index={index} />
      ))}
    </section>
  );
}

function WebEvidenceResultCard({
  result,
  index,
}: {
  result: WebEvidenceResult;
  index: number;
}) {
  const category = result.provenance.fact_category;
  const queryText = result.provenance.query_text.trim();
  const unverified = result.status === "unverified";

  return (
    <article
      className={`web-evidence-result${unverified ? " is-unverified" : ""}`}
      data-testid={`web-evidence-result-${index}`}
    >
      <div className="web-evidence-result-meta">
        <span className={`web-evidence-status-pill status-${result.status}`}>
          {STATUS_LABEL[result.status]}
        </span>
        {category ? <span className="web-evidence-category">{CATEGORY_LABEL[category]}</span> : null}
      </div>
      {queryText ? <p className="web-evidence-query">查询 {queryText}</p> : null}
      {unverified ? (
        <p
          className="web-evidence-unverified"
          role="status"
          data-testid={`web-evidence-unverified-${index}`}
        >
          <IconAlert />
          <span>{WEB_EVIDENCE_UNVERIFIED_MESSAGE}</span>
        </p>
      ) : (
        <p className="web-evidence-message">{result.message}</p>
      )}
      {result.evidence.map((item, itemIndex) => (
        <WebEvidenceItemCard
          key={`${item.url}-${itemIndex}`}
          item={item}
          resultIndex={index}
          itemIndex={itemIndex}
        />
      ))}
    </article>
  );
}

function WebEvidenceItemCard({
  item,
  resultIndex,
  itemIndex,
}: {
  item: WebEvidenceItem;
  resultIndex: number;
  itemIndex: number;
}) {
  const dateLabel = item.published_or_version_date ?? "日期未标明";

  return (
    <dl
      className="web-evidence-item"
      data-testid={`web-evidence-item-${resultIndex}-${itemIndex}`}
    >
      <div className="web-evidence-field">
        <dt>来源名称</dt>
        <dd>{item.source_name}</dd>
      </div>
      <div className="web-evidence-field">
        <dt>标题</dt>
        <dd>{item.title}</dd>
      </div>
      <div className="web-evidence-field">
        <dt>URL</dt>
        <dd>
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.url}
            <IconExternal width={11} height={11} />
          </a>
        </dd>
      </div>
      <div className="web-evidence-field">
        <dt>短摘录</dt>
        <dd>{item.excerpt}</dd>
      </div>
      <div className="web-evidence-field">
        <dt>日期</dt>
        <dd>{dateLabel}</dd>
      </div>
      <div className="web-evidence-field">
        <dt>来源等级</dt>
        <dd>
          <span className={`web-evidence-tier tier-${item.source_tier}`}>
            {TIER_LABEL[item.source_tier]}
          </span>
        </dd>
      </div>
    </dl>
  );
}
