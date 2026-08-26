"use client";

import { useEffect, useState } from "react";

import type { CreateReviewResponse, FindingAction } from "@grc/contracts";
import {
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  createReviewResponseSchema,
  isUnresolvedStatus,
} from "@grc/contracts";
import { ArticleDocument } from "@/components/review/ArticleDocument";
import { FindingList } from "@/components/review/FindingList";
import { Masthead } from "@/components/review/Masthead";
import {
  SpecialistOrchestrationPanel,
  hasPendingSpecialistVerification,
} from "@/components/review/SpecialistOrchestrationPanel";
import {
  WebEvidencePanel,
  hasUnverifiedWebEvidence,
} from "@/components/review/WebEvidencePanel";
import { IconAlert, IconBook, IconCheck, IconRefresh } from "@/components/review/icons";
import { selectAfterDecision, unresolvedFindings } from "@/lib/review-selection";

/** Keep in sync with `@media (max-width: 1023px)` in globals.css. */
export const REVIEW_COMPACT_MEDIA_QUERY = "(max-width: 1023px)";

function blockHiddenSheetEvents(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault();
  event.stopPropagation();
}

function useCompactReviewLayout() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(REVIEW_COMPACT_MEDIA_QUERY);
    const sync = () => setCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return compact;
}

type DesktopReviewLayoutProps = {
  review: CreateReviewResponse;
  onReviewChange: (review: CreateReviewResponse) => void;
  onReset: () => void;
};

const PROVIDER_LABEL: Record<string, string> = {
  fixture: "内置演示",
  deepseek: "DeepSeek",
  openai: "OpenAI",
};

const ACTION_TOAST: Record<FindingAction, string> = {
  accept: "已接受修改，正文已更新",
  ignore: "已忽略该问题",
  verify: "已标记为待核实",
};

export function DesktopReviewLayout({
  review,
  onReviewChange,
  onReset,
}: DesktopReviewLayoutProps) {
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [pendingActionFindingId, setPendingActionFindingId] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listRevealNonce, setListRevealNonce] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const compact = useCompactReviewLayout();
  const sheetContentHidden = compact && !sheetOpen;

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function selectFromArticle(findingId: string) {
    setSelectedFindingId(findingId);
    setSheetOpen(true);
    setListRevealNonce((value) => value + 1);
  }

  function selectFromList(findingId: string) {
    setSelectedFindingId(findingId);
    setFocusNonce((value) => value + 1);
  }

  async function decide(findingId: string, action: FindingAction) {
    const previous = review;
    setPendingActionFindingId(findingId);
    setActionError(null);
    try {
      const response = await fetch(
        `/api/reviews/${review.review_id}/findings/${findingId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            expected_article_version: review.article.version,
            action_id: crypto.randomUUID(),
          }),
        },
      );
      const json: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof json === "object" &&
          json !== null &&
          "error" in json &&
          typeof json.error === "string"
            ? json.error
            : "操作失败";
        throw new Error(message);
      }
      const next = createReviewResponseSchema.parse(json);
      onReviewChange(next);
      const nextSelected = selectAfterDecision(selectedFindingId, previous, next);
      setSelectedFindingId(nextSelected);
      if (nextSelected && nextSelected !== selectedFindingId) {
        setFocusNonce((value) => value + 1);
      }
      setToast(ACTION_TOAST[action]);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setPendingActionFindingId(null);
    }
  }

  const totalCount = review.findings.length;
  const unresolvedCount = unresolvedFindings(review.findings).length;
  const resolvedCount = review.findings.filter(
    (finding) => !isUnresolvedStatus(finding.status),
  ).length;
  const progressPct =
    totalCount === 0 ? 100 : Math.round((resolvedCount / totalCount) * 100);
  const providerLabel =
    PROVIDER_LABEL[review.pipeline.provider] ?? review.pipeline.provider;
  const elapsedSeconds = (review.pipeline.elapsed_ms / 1000).toFixed(1);
  const webEvidence = review.pipeline.web_evidence;
  const unverifiedWebEvidence = hasUnverifiedWebEvidence(webEvidence);
  const specialistRun = review.pipeline.specialist_orchestration ?? null;
  const pendingSpecialistVerification = hasPendingSpecialistVerification(specialistRun);

  return (
    <div
      className={`review-shell${readingMode ? " is-reading" : ""}${sheetOpen ? " is-sheet-open" : " is-sheet-collapsed"}`}
      data-testid="desktop-review"
      data-compact={compact ? "true" : "false"}
    >
      <header className="review-header">
        <Masthead />
        <div className="review-header-meta">
          <span className="review-stats" data-testid="finding-count">
            发现 {totalCount} 个问题 · 待处理 {unresolvedCount}
          </span>
          <span
            className="review-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-valuenow={resolvedCount}
            aria-label="处理进度"
          >
            <i style={{ width: `${progressPct}%` }} />
          </span>
          <span className="pipeline-meta">
            v{review.article.version} · {providerLabel}
            {review.pipeline.model ? ` · ${review.pipeline.model}` : ""} ·{" "}
            {elapsedSeconds}s
          </span>
          <button
            type="button"
            className="ghost-button"
            data-testid="reading-mode-toggle"
            aria-pressed={readingMode}
            onClick={() => setReadingMode((value) => !value)}
          >
            <IconBook />
            {readingMode ? "退出阅读" : "纯阅读"}
          </button>
          <button type="button" className="ghost-button" onClick={onReset}>
            <IconRefresh />
            重新审校
          </button>
        </div>
      </header>
      {review.pipeline.fallback?.used ? (
        <p className="fallback-banner" role="status" data-testid="fallback-banner">
          <IconAlert />
          审校模型不可用，已降级为规则结果。{review.pipeline.fallback.reason}
        </p>
      ) : null}
      {unverifiedWebEvidence ? (
        <p className="web-evidence-banner" role="status" data-testid="web-evidence-banner">
          <IconAlert />
          {WEB_EVIDENCE_UNVERIFIED_MESSAGE}。该状态不表示稿件没有问题。
        </p>
      ) : null}
      {unresolvedCount === 0 ? (
        <p className="review-complete" role="status" data-testid="review-complete">
          <IconCheck />
          本轮待处理问题已全部处理完毕。
        </p>
      ) : null}
      {actionError ? (
        <p className="form-error action-error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      ) : null}
      <div className="review-columns">
        <section className="review-pane review-pane-article" aria-label="稿件正文">
          <ArticleDocument
            article={review.article}
            findings={review.findings}
            selectedFindingId={selectedFindingId}
            focusNonce={focusNonce}
            onSelectFinding={selectFromArticle}
            hideMarks={readingMode}
          />
        </section>
        <aside
          className="review-pane review-pane-findings"
          data-testid="findings-sheet"
          aria-label="审校意见"
        >
          <button
            type="button"
            className="sheet-toggle"
            data-testid="findings-sheet-toggle"
            aria-expanded={compact ? sheetOpen : true}
            aria-controls="findings-sheet-panel"
            onClick={() => setSheetOpen((value) => !value)}
          >
            <span className="sheet-handle" aria-hidden="true" />
            <span className="sheet-summary">
              <span className="sheet-summary-count">
                审校意见 · 待处理 {unresolvedCount}
                {unverifiedWebEvidence ? ` · ${WEB_EVIDENCE_UNVERIFIED_MESSAGE}` : ""}
                {pendingSpecialistVerification ? " · 专项核验待核实" : ""}
              </span>
              <span className="sheet-summary-action">
                {sheetOpen ? "收起" : "展开"}
              </span>
            </span>
          </button>
          <div
            id="findings-sheet-panel"
            className="findings-sheet-body"
            data-testid="findings-sheet-panel"
            hidden={sheetContentHidden}
            inert={sheetContentHidden}
            onClickCapture={sheetContentHidden ? blockHiddenSheetEvents : undefined}
            onKeyDownCapture={sheetContentHidden ? blockHiddenSheetEvents : undefined}
            onPointerDownCapture={sheetContentHidden ? blockHiddenSheetEvents : undefined}
          >
            <div className="findings-head">
              <h2 className="findings-title">审校意见</h2>
              <span className="findings-count">
                共 {totalCount} 条 · 待处理 {unresolvedCount}
                {unverifiedWebEvidence ? ` · ${WEB_EVIDENCE_UNVERIFIED_MESSAGE}` : ""}
                {pendingSpecialistVerification ? " · 专项核验待核实" : ""}
              </span>
            </div>
            <SpecialistOrchestrationPanel run={specialistRun} />
            {webEvidence ? <WebEvidencePanel run={webEvidence} /> : null}
            <FindingList
              findings={review.findings}
              selectedFindingId={selectedFindingId}
              pendingActionFindingId={pendingActionFindingId}
              revealNonce={listRevealNonce}
              emptyTitle={unverifiedWebEvidence ? "本轮无正文批注" : undefined}
              emptyDetail={
                unverifiedWebEvidence
                  ? "外部网页证据未能核验，不能视为没有问题。"
                  : undefined
              }
              emptyCaution={unverifiedWebEvidence}
              onSelectFinding={selectFromList}
              onDecide={(findingId, action) => {
                void decide(findingId, action);
              }}
            />
          </div>
        </aside>
      </div>
      {toast ? (
        <p className="action-toast" role="status" data-testid="action-toast">
          {toast}
        </p>
      ) : null}
    </div>
  );
}
