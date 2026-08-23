"use client";

import { useState } from "react";

import type { CreateReviewResponse, FindingAction } from "@grc/contracts";
import { createReviewResponseSchema } from "@grc/contracts";
import { ArticleDocument } from "@/components/review/ArticleDocument";
import { FindingList } from "@/components/review/FindingList";
import { selectAfterDecision, unresolvedFindings } from "@/lib/review-selection";

type DesktopReviewLayoutProps = {
  review: CreateReviewResponse;
  onReviewChange: (review: CreateReviewResponse) => void;
  onReset: () => void;
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

  function selectFromArticle(findingId: string) {
    setSelectedFindingId(findingId);
    setSheetOpen(true);
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
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setPendingActionFindingId(null);
    }
  }

  const unresolvedCount = unresolvedFindings(review.findings).length;

  return (
    <div
      className={`review-shell${readingMode ? " is-reading" : ""}${sheetOpen ? " is-sheet-open" : " is-sheet-collapsed"}`}
      data-testid="desktop-review"
    >
      <header className="review-header">
        <div>
          <p className="eyebrow">Guangming Review Copilot</p>
          <h1>光明审校 Copilot</h1>
        </div>
        <div className="review-header-meta">
          <span data-testid="finding-count">
            发现 {review.findings.length} 个问题 · 待处理 {unresolvedCount}
          </span>
          <span className="pipeline-meta">
            v{review.article.version} · {review.pipeline.provider}
          </span>
          <button
            type="button"
            className="ghost-button"
            data-testid="reading-mode-toggle"
            onClick={() => setReadingMode((value) => !value)}
          >
            {readingMode ? "显示标注" : "纯阅读"}
          </button>
          <button type="button" className="ghost-button" onClick={onReset}>
            重新审校
          </button>
        </div>
      </header>
      {review.pipeline.fallback?.used ? (
        <p className="fallback-banner" data-testid="fallback-banner">
          审校模型不可用，已降级为规则结果。{review.pipeline.fallback.reason}
        </p>
      ) : null}
      {unresolvedCount === 0 ? (
        <p className="review-complete" data-testid="review-complete">
          本轮待处理问题已完成。
        </p>
      ) : null}
      {actionError ? (
        <p className="form-error action-error" data-testid="action-error">
          {actionError}
        </p>
      ) : null}
      <div className="review-columns">
        <section className="review-pane review-pane-article">
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
        >
          <button
            type="button"
            className="sheet-toggle"
            data-testid="findings-sheet-toggle"
            onClick={() => setSheetOpen((value) => !value)}
          >
            {sheetOpen ? "收起审校结果" : "展开审校结果"}
          </button>
          <FindingList
            findings={review.findings}
            selectedFindingId={selectedFindingId}
            pendingActionFindingId={pendingActionFindingId}
            onSelectFinding={selectFromList}
            onDecide={(findingId, action) => {
              void decide(findingId, action);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
