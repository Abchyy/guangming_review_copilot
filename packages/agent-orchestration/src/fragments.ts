import type {
  CanonicalArticle,
  SpecialistFragment,
  SpecialistPreliminaryFinding,
  SpecialistRetrievedEvidence,
  SourceSpan,
} from "@grc/contracts";

import { FRAGMENT_CONTEXT_CHARS } from "./config";

function fieldText(article: CanonicalArticle, field: SourceSpan["field"]): string {
  return field === "title" ? article.title : article.body;
}

function fragmentKey(fragment: Pick<SpecialistFragment, "field" | "start_offset" | "end_offset">): string {
  return `${fragment.field}:${fragment.start_offset}:${fragment.end_offset}`;
}

export function extractFragments(
  article: CanonicalArticle,
  findings: readonly SpecialistPreliminaryFinding[],
  contextChars = FRAGMENT_CONTEXT_CHARS,
): SpecialistFragment[] {
  const unique = new Map<string, SpecialistFragment>();
  for (const finding of findings) {
    const span = finding.source_span;
    const text = fieldText(article, span.field);
    const start = Math.min(span.start_offset, text.length);
    const end = Math.min(Math.max(span.end_offset, start), text.length);
    const quoted = text.slice(start, end) || span.quoted_text;
    if (quoted.length === 0) {
      continue;
    }
    const before = text.slice(Math.max(0, start - contextChars), start);
    const after = text.slice(end, Math.min(text.length, end + contextChars));
    const fragment: SpecialistFragment = {
      field: span.field,
      start_offset: start,
      end_offset: end,
      quoted_text: quoted,
      paragraph_index: span.paragraph_index,
      article_version: span.article_version,
      context_before: before.length > 0 ? before : null,
      context_after: after.length > 0 ? after : null,
    };
    unique.set(fragmentKey(fragment), fragment);
  }
  return [...unique.values()].sort((left, right) => {
    if (left.field !== right.field) {
      return left.field.localeCompare(right.field);
    }
    return left.start_offset - right.start_offset || left.end_offset - right.end_offset;
  });
}

export function fragmentToSpan(fragment: SpecialistFragment): SourceSpan {
  return {
    field: fragment.field,
    start_offset: fragment.start_offset,
    end_offset: fragment.end_offset,
    quoted_text: fragment.quoted_text,
    paragraph_index: fragment.paragraph_index,
    article_version: fragment.article_version,
  };
}

export function evidenceForFragments(
  fragments: readonly SpecialistFragment[],
  findings: readonly SpecialistPreliminaryFinding[],
  evidence: readonly SpecialistRetrievedEvidence[],
): SpecialistRetrievedEvidence[] {
  if (evidence.length === 0 || (fragments.length === 0 && findings.length === 0)) {
    return [];
  }
  const haystacks = [
    ...fragments.map((item) => item.quoted_text),
    ...findings.map((item) => `${item.title}\n${item.reason}\n${item.source_span.quoted_text}`),
  ];
  return evidence.filter((item) =>
    haystacks.some(
      (text) =>
        (item.trigger.length > 0 && text.includes(item.trigger)) ||
        (item.excerpt.length > 0 && text.includes(item.excerpt)) ||
        (item.excerpt.length > 0 && item.excerpt.includes(item.trigger) && text.includes(item.trigger)),
    ),
  );
}

export function specialistTaskContainsFullArticle(
  task: { article?: CanonicalArticle; fragments?: readonly SpecialistFragment[] },
  article: CanonicalArticle,
): boolean {
  if (task.article?.body === article.body && article.body.length > 0) {
    return true;
  }
  const packed = JSON.stringify(task);
  if (article.body.length === 0 || !packed.includes(article.body)) {
    return false;
  }
  const windows = (task.fragments ?? []).map(
    (fragment) => `${fragment.context_before ?? ""}${fragment.quoted_text}${fragment.context_after ?? ""}`,
  );
  return !windows.some((window) => window.includes(article.body));
}
