"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

import type { CanonicalArticle, Finding } from "@grc/contracts";
import { segmentField, type TextSegment } from "@/lib/highlight-segments";

type ArticleDocumentProps = {
  article: CanonicalArticle;
  findings: Finding[];
  selectedFindingId: string | null;
  focusNonce: number;
  onSelectFinding: (findingId: string) => void;
  hideMarks?: boolean;
};

export function ArticleDocument({
  article,
  findings,
  selectedFindingId,
  focusNonce,
  onSelectFinding,
  hideMarks = false,
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

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
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
        {hideMarks
          ? article.title
          : renderSegments(titleSegments, selectedFindingId, onSelectFinding)}
      </h1>
      <div className="article-rule" aria-hidden="true" />
      <div data-testid="article-body" className="article-body">
        {hideMarks
          ? renderPlainParagraphs(article.body)
          : renderBodyParagraphs(bodySegments, selectedFindingId, onSelectFinding)}
      </div>
    </article>
  );
}

function renderPlainParagraphs(text: string): ReactNode {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph, index) => <p key={index}>{paragraph}</p>);
}

function renderBodyParagraphs(
  segments: TextSegment[],
  selectedFindingId: string | null,
  onSelectFinding: (findingId: string) => void,
): ReactNode {
  const paragraphs: { segment: TextSegment; text: string }[][] = [[]];
  for (const segment of segments) {
    const chunks = segment.text.split(/\n{2,}/);
    chunks.forEach((chunk, chunkIndex) => {
      if (chunkIndex > 0) {
        paragraphs.push([]);
      }
      if (chunk.length > 0) {
        paragraphs[paragraphs.length - 1]!.push({ segment, text: chunk });
      }
    });
  }

  return paragraphs.map((paragraph, paragraphIndex) => (
    <p key={paragraphIndex}>
      {paragraph.map((part, partIndex) =>
        renderSegment(
          part.segment,
          part.text,
          `${part.segment.start}-${part.segment.end}-${partIndex}`,
          selectedFindingId,
          onSelectFinding,
        ),
      )}
    </p>
  ));
}

function renderSegments(
  segments: TextSegment[],
  selectedFindingId: string | null,
  onSelectFinding: (findingId: string) => void,
): ReactNode {
  return segments.map((segment) =>
    renderSegment(
      segment,
      segment.text,
      `${segment.start}-${segment.end}`,
      selectedFindingId,
      onSelectFinding,
    ),
  );
}

function renderSegment(
  segment: TextSegment,
  text: string,
  key: string,
  selectedFindingId: string | null,
  onSelectFinding: (findingId: string) => void,
): ReactNode {
  const findingId = segment.primaryFindingId;
  if (!findingId) {
    return <span key={key}>{text}</span>;
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
      key={key}
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
      {text}
    </mark>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
