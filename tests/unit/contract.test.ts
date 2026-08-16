import { describe, expect, test } from "vitest";

import {
  llmReviewOutputSchema,
  parseLlmReviewOutput,
  ReviewProviderError,
  sourceCandidateSchema,
} from "@/lib/contracts/review";

const validCandidate = {
  type: "person",
  severity: "high",
  title: "职务可能有误",
  reason: "人名与职务不匹配。",
  suggestion: "市委书记张明",
  confidence: 0.8,
  evidence: {
    type: "ai_judgment",
    summary: "仅根据文内信息判断。",
    items: [],
  },
  source: {
    field: "body",
    exact_quote: "市委书记张三",
    paragraph_index: 0,
    context_before: null,
    context_after: null,
  },
};

describe("LLM candidate contract", () => {
  test("accepts valid structured output", () => {
    const parsed = parseLlmReviewOutput({ candidates: [validCandidate] });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.type).toBe("person");
  });

  test("rejects malformed output", () => {
    expect(() => parseLlmReviewOutput({ findings: [] })).toThrow(
      ReviewProviderError,
    );
    expect(() => parseLlmReviewOutput(null)).toThrow(ReviewProviderError);
    expect(() => parseLlmReviewOutput("not-json-object")).toThrow(
      ReviewProviderError,
    );
  });

  test("rejects invalid enum", () => {
    const result = llmReviewOutputSchema.safeParse({
      candidates: [
        {
          ...validCandidate,
          type: "typo",
          severity: "urgent",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid source candidate", () => {
    expect(
      sourceCandidateSchema.safeParse({
        field: "body",
        exact_quote: "",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      }).success,
    ).toBe(false);

    expect(
      sourceCandidateSchema.safeParse({
        field: "headline",
        exact_quote: "张三",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      }).success,
    ).toBe(false);

    expect(
      llmReviewOutputSchema.safeParse({
        candidates: [
          {
            ...validCandidate,
            source: {
              field: "body",
              exact_quote: "",
              paragraph_index: -1,
              context_before: null,
              context_after: null,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
