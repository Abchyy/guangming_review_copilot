import type {
  ArticleField,
  CanonicalArticle,
  SourceCandidate,
  SourceSpan,
} from "@grc/contracts";

export type ExactMatch = {
  start: number;
  end: number;
};

export function fieldText(
  article: CanonicalArticle,
  field: ArticleField,
): string {
  return field === "title" ? article.title : article.body;
}

/**
 * Paragraph index is the 0-based line number within the field,
 * using `\n` as the separator. Offsets are UTF-16 code units.
 */
export function paragraphIndexAt(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let index = 0;
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) {
      index += 1;
    }
  }
  return index;
}

export function findAllExact(text: string, quote: string): ExactMatch[] {
  const matches: ExactMatch[] = [];
  if (quote.length === 0) {
    return matches;
  }

  let from = 0;
  while (from <= text.length - quote.length) {
    const start = text.indexOf(quote, from);
    if (start === -1) {
      break;
    }
    matches.push({ start, end: start + quote.length });
    from = start + 1;
  }
  return matches;
}

function hasExactAdjacentContext(
  text: string,
  match: ExactMatch,
  contextBefore: string | null,
  contextAfter: string | null,
): boolean {
  if (contextBefore && contextBefore.length > 0) {
    const actual = text.slice(
      Math.max(0, match.start - contextBefore.length),
      match.start,
    );
    if (actual !== contextBefore) {
      return false;
    }
  }

  if (contextAfter && contextAfter.length > 0) {
    const actual = text.slice(match.end, match.end + contextAfter.length);
    if (actual !== contextAfter) {
      return false;
    }
  }

  return true;
}

function toSpan(
  article: CanonicalArticle,
  field: ArticleField,
  match: ExactMatch,
): SourceSpan {
  const text = fieldText(article, field);
  const quotedText = text.slice(match.start, match.end);

  return {
    field,
    start_offset: match.start,
    end_offset: match.end,
    quoted_text: quotedText,
    paragraph_index: paragraphIndexAt(text, match.start),
    article_version: article.version,
  };
}

/**
 * Backend is the only source-span authority.
 * The model may supply location clues, never final offsets.
 */
export function locateSourceSpan(
  article: CanonicalArticle,
  candidate: SourceCandidate,
): SourceSpan | null {
  const text = fieldText(article, candidate.field);
  const quote = candidate.exact_quote;
  if (!quote) {
    return null;
  }

  let matches = findAllExact(text, quote);
  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    const span = toSpan(article, candidate.field, matches[0]);
    return assertSliceEqualsQuotedText(text, span);
  }

  matches = matches.filter(
    (match) =>
      paragraphIndexAt(text, match.start) === candidate.paragraph_index,
  );
  if (matches.length === 1) {
    return assertSliceEqualsQuotedText(
      text,
      toSpan(article, candidate.field, matches[0]),
    );
  }

  if (matches.length === 0) {
    return null;
  }

  matches = matches.filter((match) =>
    hasExactAdjacentContext(
      text,
      match,
      candidate.context_before,
      candidate.context_after,
    ),
  );

  if (matches.length !== 1) {
    return null;
  }

  return assertSliceEqualsQuotedText(
    text,
    toSpan(article, candidate.field, matches[0]),
  );
}

export function locateUniqueExcerptSpans(
  article: CanonicalArticle,
  excerpt: string,
): SourceSpan[] {
  if (!excerpt) {
    return [];
  }

  const spans: SourceSpan[] = [];
  for (const field of ["title", "body"] as const) {
    const text = fieldText(article, field);
    const matches = findAllExact(text, excerpt);
    if (matches.length === 1) {
      spans.push(assertSliceEqualsQuotedText(text, toSpan(article, field, matches[0])));
    }
  }
  return spans;
}

export function assertSliceEqualsQuotedText(
  text: string,
  span: SourceSpan,
): SourceSpan {
  const sliced = text.slice(span.start_offset, span.end_offset);
  if (sliced !== span.quoted_text) {
    throw new Error(
      "source span invariant failed: quoted_text !== canonicalText.slice(start, end)",
    );
  }
  return span;
}
