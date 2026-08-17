import { describe, expect, test } from "vitest";

const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)("OpenAI live smoke (benchmark-only, not production)", () => {
  test("live provider returns schema-valid candidates at least once", async () => {
    const { OpenAIReviewModel } = await import(
      "@/lib/server/llm/openai-review-model"
    );
    const { createReview } = await import("@/lib/server/review-service");
    const model = new OpenAIReviewModel({ apiKey });
    const result = await createReview(
      {
        title: "我市召开座谈会",
        body: "市教育局局长王海涛出席。王强在总结时强调要抓好开学工作。",
      },
      model,
    );
    expect(result.pipeline.provider).toBe("openai");
    expect(Array.isArray(result.findings)).toBe(true);
    for (const finding of result.findings) {
      const text =
        finding.source_span.field === "title"
          ? result.article.title
          : result.article.body;
      expect(
        text.slice(
          finding.source_span.start_offset,
          finding.source_span.end_offset,
        ),
      ).toBe(finding.source_span.quoted_text);
    }
  }, 60_000);
});
