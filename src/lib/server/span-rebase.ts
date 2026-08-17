import type {
  CanonicalArticle,
  Finding,
  FindingStatus,
  SourceSpan,
} from "@/lib/contracts/review";
import { fieldText, paragraphIndexAt } from "@/lib/server/span-locator";

export type EditRange = {
  field: SourceSpan["field"];
  start: number;
  end: number;
  replacementLength: number;
};

function spansOverlap(left: SourceSpan, right: {
  field: SourceSpan["field"];
  start_offset: number;
  end_offset: number;
}): boolean {
  if (left.field !== right.field) {
    return false;
  }
  return left.start_offset < right.end_offset && right.start_offset < left.end_offset;
}

function quoteStillMatches(article: CanonicalArticle, span: SourceSpan): boolean {
  const text = fieldText(article, span.field);
  if (span.start_offset < 0 || span.end_offset > text.length || span.end_offset < span.start_offset) {
    return false;
  }
  return text.slice(span.start_offset, span.end_offset) === span.quoted_text;
}

function shiftSpan(span: SourceSpan, delta: number, articleVersion: number): SourceSpan {
  const start = span.start_offset + delta;
  const end = span.end_offset + delta;
  return {
    ...span,
    start_offset: start,
    end_offset: end,
    paragraph_index: span.paragraph_index,
    article_version: articleVersion,
  };
}

function rebaseSpanParagraph(
  article: CanonicalArticle,
  span: SourceSpan,
): SourceSpan {
  const text = fieldText(article, span.field);
  return {
    ...span,
    paragraph_index: paragraphIndexAt(text, span.start_offset),
  };
}

function invalidate(finding: Finding): Finding {
  return { ...finding, status: "invalidated" };
}

const TERMINAL: ReadonlySet<FindingStatus> = new Set(["invalidated"]);

export function rebaseFindingsAfterAccept(options: {
  article: CanonicalArticle;
  findings: Finding[];
  acceptedFindingId: string;
  edit: EditRange;
}): Finding[] {
  const { article, findings, acceptedFindingId, edit } = options;
  const delta = edit.replacementLength - (edit.end - edit.start);
  const editSpan = {
    field: edit.field,
    start_offset: edit.start,
    end_offset: edit.end,
  };

  return findings.map((finding) => {
    if (finding.finding_id === acceptedFindingId) {
      const replacement = finding.suggestion.replacement;
      if (replacement == null) {
        return invalidate(finding);
      }
      const acceptedSpan: SourceSpan = rebaseSpanParagraph(article, {
        field: edit.field,
        start_offset: edit.start,
        end_offset: edit.start + replacement.length,
        quoted_text: replacement,
        paragraph_index: 0,
        article_version: article.version,
      });
      return {
        ...finding,
        status: "accepted",
        source_span: acceptedSpan,
      };
    }

    if (TERMINAL.has(finding.status)) {
      return finding;
    }

    const sourceOverlaps = spansOverlap(finding.source_span, editSpan);
    const evidenceOverlaps = (finding.evidence ?? []).some((item) =>
      (item.article_spans ?? []).some((span) => spansOverlap(span, editSpan)),
    );
    if (sourceOverlaps || evidenceOverlaps) {
      return invalidate(finding);
    }

    let next: Finding = finding;
    if (finding.source_span.field === edit.field && finding.source_span.start_offset >= edit.end) {
      next = {
        ...next,
        source_span: rebaseSpanParagraph(
          article,
          shiftSpan(next.source_span, delta, article.version),
        ),
      };
    } else {
      next = {
        ...next,
        source_span: {
          ...next.source_span,
          article_version: article.version,
        },
      };
    }

    next = {
      ...next,
      evidence: next.evidence.map((item) => ({
        ...item,
        article_spans: (item.article_spans ?? []).map((span) => {
          if (span.field === edit.field && span.start_offset >= edit.end) {
            return rebaseSpanParagraph(article, shiftSpan(span, delta, article.version));
          }
          return { ...span, article_version: article.version };
        }),
      })),
    };

    if (!quoteStillMatches(article, next.source_span)) {
      return invalidate(next);
    }
    const evidenceMismatch = next.evidence.some((item) =>
      (item.article_spans ?? []).some((span) => !quoteStillMatches(article, span)),
    );
    if (evidenceMismatch) {
      return invalidate(next);
    }
    return next;
  });
}

export function applyReplacement(
  article: CanonicalArticle,
  span: SourceSpan,
  replacement: string,
): CanonicalArticle {
  const text = fieldText(article, span.field);
  const nextText =
    text.slice(0, span.start_offset) + replacement + text.slice(span.end_offset);
  if (span.field === "title") {
    return { ...article, title: nextText, version: article.version + 1 };
  }
  return { ...article, body: nextText, version: article.version + 1 };
}
