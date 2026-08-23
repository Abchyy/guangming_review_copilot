import { describe, expect, test } from "vitest";

import type { CanonicalArticle, Finding, SourceSpan } from "@grc/contracts";
import {
  applyReplacement,
  rebaseFindingsAfterAccept,
} from "@grc/review-store";

function span(
  field: SourceSpan["field"],
  start: number,
  quote: string,
): SourceSpan {
  return {
    field,
    start_offset: start,
    end_offset: start + quote.length,
    quoted_text: quote,
    paragraph_index: 0,
    article_version: 1,
  };
}

function finding(id: string, source: SourceSpan, extras?: Partial<Finding>): Finding {
  return {
    finding_id: id,
    type: "basic_text",
    severity: "low",
    source_span: source,
    title: id,
    reason: "r",
    suggestion: extras?.suggestion ?? { text: source.quoted_text, replacement: "X" },
    confidence: 0.9,
    evidence: extras?.evidence ?? [],
    status: extras?.status ?? "pending",
  };
}

describe("span rebase", () => {
  test("edit before a finding shifts it by delta", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "abc错误def错字",
      version: 2,
    };
    const accepted = finding("a", span("body", 3, "错误"), {
      suggestion: { text: "正确", replacement: "正确" },
    });
    const later = finding("b", span("body", 8, "错字"));
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, later],
      acceptedFindingId: "a",
      edit: { field: "body", start: 3, end: 5, replacementLength: 2 },
    });
    const rebased = next.find((item) => item.finding_id === "b");
    expect(rebased?.status).toBe("pending");
    expect(rebased?.source_span.start_offset).toBe(8);
    expect(article.body.slice(8, 10)).toBe("错字");
  });

  test("positive delta shifts later spans", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "abc正确的def错字",
      version: 2,
    };
    const accepted = finding("a", span("body", 3, "错误"), {
      suggestion: { text: "正确的", replacement: "正确的" },
    });
    const later = finding("b", span("body", 8, "错字"));
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, later],
      acceptedFindingId: "a",
      edit: { field: "body", start: 3, end: 5, replacementLength: 3 },
    });
    expect(next.find((item) => item.finding_id === "b")?.source_span.start_offset).toBe(9);
  });

  test("negative delta shifts later spans backward", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "abc对def错字",
      version: 2,
    };
    const accepted = finding("a", span("body", 3, "错误"), {
      suggestion: { text: "对", replacement: "对" },
    });
    const later = finding("b", span("body", 8, "错字"));
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, later],
      acceptedFindingId: "a",
      edit: { field: "body", start: 3, end: 5, replacementLength: 1 },
    });
    expect(next.find((item) => item.finding_id === "b")?.source_span.start_offset).toBe(7);
  });

  test("edit after a finding leaves earlier offsets unchanged", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "错字abc正确",
      version: 2,
    };
    const earlier = finding("a", span("body", 0, "错字"));
    const accepted = finding("b", span("body", 5, "错误"), {
      suggestion: { text: "正确", replacement: "正确" },
    });
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [earlier, accepted],
      acceptedFindingId: "b",
      edit: { field: "body", start: 5, end: 7, replacementLength: 2 },
    });
    expect(next.find((item) => item.finding_id === "a")?.source_span.start_offset).toBe(0);
  });

  test("overlap invalidates the other finding", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "正确的字",
      version: 2,
    };
    const accepted = finding("a", span("body", 0, "错误字"), {
      suggestion: { text: "正确的字", replacement: "正确的字" },
    });
    const overlap = finding("b", span("body", 2, "误字"));
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, overlap],
      acceptedFindingId: "a",
      edit: { field: "body", start: 0, end: 3, replacementLength: 4 },
    });
    expect(next.find((item) => item.finding_id === "b")?.status).toBe("invalidated");
  });

  test("title mutation does not change body offsets", () => {
    const article: CanonicalArticle = {
      title: "正确标题",
      body: "正文错字",
      version: 2,
    };
    const titleFinding = finding("a", span("title", 0, "错误标题"), {
      suggestion: { text: "正确标题", replacement: "正确标题" },
    });
    const bodyFinding = finding("b", span("body", 2, "错字"));
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [titleFinding, bodyFinding],
      acceptedFindingId: "a",
      edit: { field: "title", start: 0, end: 4, replacementLength: 4 },
    });
    expect(next.find((item) => item.finding_id === "b")?.source_span.start_offset).toBe(2);
  });

  test("UTF-16 emoji delta stays on JS string offsets", () => {
    const thumbs = "👍";
    expect(thumbs.length).toBe(2);
    const original = `hi${thumbs}错误`;
    const replaced = `hi${thumbs}正确`;
    const errorStart = original.indexOf("错误");
    const article: CanonicalArticle = { title: "T", body: replaced, version: 2 };
    const accepted = finding("a", span("body", errorStart, "错误"), {
      suggestion: { text: "正确", replacement: "正确" },
    });
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted],
      acceptedFindingId: "a",
      edit: {
        field: "body",
        start: errorStart,
        end: errorStart + 2,
        replacementLength: 2,
      },
    });
    const acceptedFinding = next[0];
    expect(acceptedFinding?.source_span.quoted_text).toBe("正确");
    expect(replaced.slice(acceptedFinding!.source_span.start_offset, acceptedFinding!.source_span.end_offset)).toBe("正确");
  });

  test("quote revalidation failure invalidates", () => {
    const article: CanonicalArticle = { title: "T", body: "abc正确def????", version: 2 };
    const accepted = finding("a", span("body", 3, "错误"), {
      suggestion: { text: "正确", replacement: "正确" },
    });
    const stale = finding("b", {
      ...span("body", 8, "错字"),
      quoted_text: "不是这段",
    });
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, stale],
      acceptedFindingId: "a",
      edit: { field: "body", start: 3, end: 5, replacementLength: 2 },
    });
    expect(next.find((item) => item.finding_id === "b")?.status).toBe("invalidated");
  });

  test("evidence span overlap invalidates the finding", () => {
    const article: CanonicalArticle = { title: "T", body: "正确后文数字", version: 2 };
    const accepted = finding("a", span("body", 0, "错误"), {
      suggestion: { text: "正确", replacement: "正确" },
    });
    const other = finding("b", span("body", 4, "数字"), {
      evidence: [
        {
          kind: "internal_context",
          excerpt: "错误",
          citation_validated: true,
          article_spans: [span("body", 0, "错误")],
        },
      ],
    });
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, other],
      acceptedFindingId: "a",
      edit: { field: "body", start: 0, end: 2, replacementLength: 2 },
    });
    expect(next.find((item) => item.finding_id === "b")?.status).toBe("invalidated");
  });

  test("evidence spans after an edit shift and still match the new article", () => {
    const article: CanonicalArticle = {
      title: "T",
      body: "abc正确的def数字",
      version: 2,
    };
    const accepted = finding("a", span("body", 3, "错误"), {
      suggestion: { text: "正确的", replacement: "正确的" },
    });
    const later = finding("b", span("body", 8, "数字"), {
      evidence: [
        {
          kind: "internal_context",
          excerpt: "数字",
          citation_validated: true,
          article_spans: [span("body", 8, "数字")],
        },
      ],
    });
    const next = rebaseFindingsAfterAccept({
      article,
      findings: [accepted, later],
      acceptedFindingId: "a",
      edit: { field: "body", start: 3, end: 5, replacementLength: 3 },
    });
    const rebased = next.find((item) => item.finding_id === "b");
    expect(rebased?.status).toBe("pending");
    expect(rebased?.source_span.start_offset).toBe(9);
    expect(article.body.slice(9, 11)).toBe("数字");
    const evidenceSpan = rebased?.evidence[0]?.article_spans?.[0];
    expect(evidenceSpan?.start_offset).toBe(9);
    expect(article.body.slice(evidenceSpan!.start_offset, evidenceSpan!.end_offset)).toBe(
      evidenceSpan?.quoted_text,
    );
  });

  test("applyReplacement mutates the targeted field only", () => {
    const article: CanonicalArticle = { title: "错误标题", body: "abc错误def", version: 1 };
    const titleNext = applyReplacement(article, span("title", 0, "错误标题"), "正确标题");
    expect(titleNext.title).toBe("正确标题");
    expect(titleNext.body).toBe(article.body);
    expect(titleNext.version).toBe(2);
    const bodyNext = applyReplacement(article, span("body", 3, "错误"), "正确");
    expect(bodyNext.body).toBe("abc正确def");
    expect(bodyNext.title).toBe(article.title);
  });
});
