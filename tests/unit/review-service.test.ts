import { describe, expect, test } from "vitest";

import { createReview } from "@/lib/server/review-service";
import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import type { ReviewCandidate } from "@/lib/contracts/review";

const unlocatable: ReviewCandidate = {
  type: "person",
  severity: "high",
  title: "无法定位",
  reason: "这条线索不在原文中。",
  suggestion: null,
  confidence: 0.4,
  evidence: { type: "ai_judgment", summary: "无", items: [] },
  source: {
    field: "body",
    exact_quote: "这段文字根本不存在",
    paragraph_index: 0,
    context_before: null,
    context_after: null,
  },
};

describe("review service", () => {
  test("drops unlocatable candidates instead of guessing spans", async () => {
    const result = await createReview(
      { title: "标题", body: "正文里没有那条线索。" },
      new FixtureReviewModel([unlocatable]),
    );
    expect(result.findings).toEqual([]);
    expect(result.pipeline.candidate_count).toBe(1);
    expect(result.pipeline.dropped_count).toBe(1);
  });
});
