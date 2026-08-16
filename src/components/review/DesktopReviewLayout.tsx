"use client";

import { useState } from "react";

import type { CreateReviewResponse } from "@/lib/contracts/review";
import { ArticleDocument } from "@/components/review/ArticleDocument";
import { FindingList } from "@/components/review/FindingList";

type DesktopReviewLayoutProps = {
  review: CreateReviewResponse;
  onReset: () => void;
};

export function DesktopReviewLayout({
  review,
  onReset,
}: DesktopReviewLayoutProps) {
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  const [focusNonce, setFocusNonce] = useState(0);

  function selectFromArticle(findingId: string) {
    setSelectedFindingId(findingId);
  }

  function selectFromList(findingId: string) {
    setSelectedFindingId(findingId);
    setFocusNonce((value) => value + 1);
  }

  return (
    <div className="review-shell" data-testid="desktop-review">
      <header className="review-header">
        <div>
          <p className="eyebrow">Guangming Review Copilot</p>
          <h1>光明审校 Copilot</h1>
        </div>
        <div className="review-header-meta">
          <span data-testid="finding-count">
            发现 {review.findings.length} 个问题
          </span>
          <span className="pipeline-meta">
            {review.pipeline.provider}
            {review.pipeline.dropped_count > 0
              ? ` · 未定位 ${review.pipeline.dropped_count}`
              : ""}
          </span>
          <button type="button" className="ghost-button" onClick={onReset}>
            重新审校
          </button>
        </div>
      </header>
      <div className="review-columns">
        <section className="review-pane review-pane-article">
          <ArticleDocument
            article={review.article}
            findings={review.findings}
            selectedFindingId={selectedFindingId}
            focusNonce={focusNonce}
            onSelectFinding={selectFromArticle}
          />
        </section>
        <aside className="review-pane review-pane-findings">
          <FindingList
            findings={review.findings}
            selectedFindingId={selectedFindingId}
            onSelectFinding={selectFromList}
          />
        </aside>
      </div>
    </div>
  );
}
