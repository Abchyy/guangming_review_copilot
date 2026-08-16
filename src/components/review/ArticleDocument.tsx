"use client";

import { useEffect, useMemo, useRef } from "react";

import type { CanonicalArticle, Finding } from "@/lib/contracts/review";
import { segmentField, type TextSegment } from "@/lib/highlight-segments";

type ArticleDocumentProps = {
  article: CanonicalArticle;
  findings: Finding[];
  selectedFindingId: string | null;
  focusNonce: number;
  onSelectFinding: (findingId: string) => void;
};

export function ArticleDocument({
  article,
  findings,
  selectedFindingId,
  focusNonce,
  onSelectFinding,
}: ArticleDocumentProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const titleSegments = useMemo(
    () => segmentField(article.title, findings, "title"),
    [article.title, findings],
  );
  const bodySegments = useMemo(
    () => segmentField(article.body, findings, "body"),
    [article.body, findings],
  );

  useEffect(() => {
    if (!selectedFindingId || focusNonce === 0) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    const target = root.querySelector<HTMLElement>(
      `[data-finding-ids~="${cssEscape(selectedFindingId)}"]`,
    );
    if (!target) {
      return;
    }

    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.remove("finding-flash");
    void target.offsetWidth;
    target.classList.add("finding-flash");
    const timer = window.setTimeout(() => {
      target.classList.remove("finding-flash");
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [selectedFindingId, focusNonce]);

  return (
    <article
      ref={rootRef}
      data-testid="article-document"
      className="article-document"
    >
      <h1 data-testid="article-title" className="article-title">
        {renderSegments(titleSegments, selectedFindingId, onSelectFinding)}
      </h1>
      <div data-testid="article-body" className="article-body">
        {renderSegments(bodySegments, selectedFindingId, onSelectFinding)}
      </div>
    </article>
  );
}

function renderSegments(
  segments: TextSegment[],
  selectedFindingId: string | null,
  onSelectFinding: (findingId: string) => void,
) {
  return segments.map((segment) => {
    const findingId = segment.primaryFindingId;
    if (!findingId) {
      return (
        <span key={`${segment.start}-${segment.end}`}>{segment.text}</span>
      );
    }

    const selected = segment.findingIds.includes(selectedFindingId ?? "");
    const className = [
      "source-mark",
      segment.primarySeverity ? `severity-${segment.primarySeverity}` : "",
      selected ? "is-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <mark
        key={`${segment.start}-${segment.end}`}
        data-testid="source-mark"
        data-finding-ids={segment.findingIds.join(" ")}
        data-primary-finding-id={findingId}
        className={className}
        role="button"
        tabIndex={0}
        onClick={() => {
          onSelectFinding(findingId);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectFinding(findingId);
          }
        }}
      >
        {segment.text}
      </mark>
    );
  });
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
