import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseLlmReviewOutput, type CanonicalArticle } from "@grc/contracts";
import { canonicalize } from "@grc/review-core";
import {
  findAllExact,
  locateSourceSpan,
  paragraphIndexAt,
} from "@grc/review-core";

function article(title: string, body: string): CanonicalArticle {
  return {
    title: canonicalize(title),
    body: canonicalize(body),
    version: 1,
  };
}

function candidate(
  exactQuote: string,
  extras?: Partial<{
    field: "title" | "body";
    paragraph_index: number;
    context_before: string | null;
    context_after: string | null;
  }>,
) {
  return {
    field: extras?.field ?? "body",
    exact_quote: exactQuote,
    paragraph_index: extras?.paragraph_index ?? 0,
    context_before: extras?.context_before ?? null,
    context_after: extras?.context_after ?? null,
  };
}

function expectSpan(
  text: string,
  span: { start_offset: number; end_offset: number; quoted_text: string },
) {
  expect(text.slice(span.start_offset, span.end_offset)).toBe(span.quoted_text);
}

describe("span locator", () => {
  test("locates ordinary Chinese text", () => {
    const current = article("标题", "市委书记张明到基层调研。");
    const span = locateSourceSpan(current, candidate("张明"));
    expect(span).not.toBeNull();
    expectSpan(current.body, span!);
    expect(span?.start_offset).toBe(current.body.indexOf("张明"));
  });

  test("locates Chinese punctuation exactly", () => {
    const current = article("标题", "他说：“好的。”随后离开。");
    const span = locateSourceSpan(current, candidate("他说：“好的。”"));
    expect(span).not.toBeNull();
    expectSpan(current.body, span!);
  });

  test("locates quotes that include newlines", () => {
    const current = article("标题", "第一行内容\n第二行内容");
    const span = locateSourceSpan(current, candidate("第一行内容\n第二行内容"));
    expect(span).not.toBeNull();
    expectSpan(current.body, span!);
    expect(span?.paragraph_index).toBe(0);
  });

  test("duplicate quote uses paragraph index", () => {
    const current = article("标题", "共有128人参加。\n共有128人参加。");
    const first = locateSourceSpan(
      current,
      candidate("共有128人参加", { paragraph_index: 0 }),
    );
    const second = locateSourceSpan(
      current,
      candidate("共有128人参加", { paragraph_index: 1 }),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.start_offset).toBe(0);
    expect(second?.start_offset).toBe(current.body.lastIndexOf("共有128人参加"));
    expectSpan(current.body, first!);
    expectSpan(current.body, second!);
  });

  test("context disambiguates duplicates in the same paragraph", () => {
    const current = article("标题", "他说很好，后来他又说很好。");
    const first = locateSourceSpan(
      current,
      candidate("很好", {
        paragraph_index: 0,
        context_before: "他说",
        context_after: "，后来",
      }),
    );
    const second = locateSourceSpan(
      current,
      candidate("很好", {
        paragraph_index: 0,
        context_before: "他又说",
        context_after: "。",
      }),
    );
    expect(first?.start_offset).toBe(current.body.indexOf("很好"));
    expect(second?.start_offset).toBe(current.body.lastIndexOf("很好"));
    expectSpan(current.body, first!);
    expectSpan(current.body, second!);
  });

  test("handles Unicode emoji with UTF-16 offsets", () => {
    const current = article("标题", "现场气氛👍热烈");
    const span = locateSourceSpan(current, candidate("👍"));
    expect(span).not.toBeNull();
    expect("👍".length).toBe(2);
    expect(span?.start_offset).toBe(4);
    expect(span?.end_offset).toBe(6);
    expectSpan(current.body, span!);
  });

  test("drops unlocatable candidates", () => {
    const current = article("标题", "本文没有这个问题。");
    expect(locateSourceSpan(current, candidate("王海涛"))).toBeNull();
  });

  test("rejects still-ambiguous candidates", () => {
    const current = article("标题", "很好很好");
    expect(
      locateSourceSpan(
        current,
        candidate("很好", {
          paragraph_index: 0,
          context_before: null,
          context_after: null,
        }),
      ),
    ).toBeNull();
  });

  test("unique match wins even if paragraph_index is wrong", () => {
    const current = article("标题", "只有一处张三。");
    const span = locateSourceSpan(
      current,
      candidate("张三", { paragraph_index: 99 }),
    );
    expect(span).not.toBeNull();
    expectSpan(current.body, span!);
  });

  test("title field is searched independently from body", () => {
    const current = article("张三来访", "正文没有这个名字。");
    const span = locateSourceSpan(
      current,
      candidate("张三", { field: "title" }),
    );
    expect(span?.field).toBe("title");
    expectSpan(current.title, span!);
    expect(
      locateSourceSpan(current, candidate("张三", { field: "body" })),
    ).toBeNull();
  });

  test("findAllExact can return overlapping UTF-16 matches", () => {
    expect(findAllExact("aaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ]);
  });

  test("paragraphIndexAt counts newline separators", () => {
    expect(paragraphIndexAt("a\n\nb", 3)).toBe(2);
  });

  test("demo fixture candidates all locate uniquely", () => {
    const demoArticle = JSON.parse(
      readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
    ) as { title: string; body: string };
    const demoCandidates = parseLlmReviewOutput(
      JSON.parse(
        readFileSync(
          join(process.cwd(), "data/fixtures/demo-candidates.json"),
          "utf8",
        ),
      ),
    ).candidates;

    const current = article(demoArticle.title, demoArticle.body);
    for (const item of demoCandidates) {
      const span = locateSourceSpan(current, item.source);
      expect(span, `failed to locate: ${item.source.exact_quote}`).not.toBeNull();
      const text = item.source.field === "title" ? current.title : current.body;
      expectSpan(text, span!);
    }
  });
});
