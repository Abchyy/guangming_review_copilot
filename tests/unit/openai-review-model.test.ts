import { describe, expect, test, vi } from "vitest";

import { OpenAIReviewModel } from "@/lib/server/llm/openai-review-model";
import { parseLlmReviewOutput, ReviewProviderError } from "@/lib/contracts/review";
import { getReviewModelName } from "@/lib/server/config";

const validOutput = {
  candidates: [
    {
      type: "basic_text",
      severity: "low",
      title: "错别字",
      reason: "测试",
      suggestion: {
        text: "座谈会",
        replacement: "座谈会",
      },
      confidence: 0.9,
      evidence: [
        { kind: "ai_judgment", excerpt: "测试", citation_validated: false },
      ],
      source: {
        field: "body",
        exact_quote: "座谈谈会",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      },
    },
  ],
};

describe("OpenAI review model", () => {
  test("uses server-side model configuration and structured output", async () => {
    const parse = vi.fn().mockResolvedValue({
      output_parsed: validOutput,
    });
    const model = new OpenAIReviewModel({
      apiKey: "sk-test",
      model: getReviewModelName(),
      client: { responses: { parse } } as never,
    });

    const candidates = await model.review({
      title: "标题",
      body: "座谈谈会",
      version: 1,
    });

    expect(model.model).toBe(getReviewModelName());
    expect(parse).toHaveBeenCalledTimes(1);
    const arg = parse.mock.calls[0]?.[0] as {
      model: string;
      text: { format: { type?: string; name?: string } };
    };
    expect(arg.model).toBe(getReviewModelName());
    expect(arg.text.format).toBeTruthy();
    expect(parseLlmReviewOutput({ candidates }).candidates).toHaveLength(1);
  });

  test("treats a null parsed payload as schema validation failure", async () => {
    const model = new OpenAIReviewModel({
      apiKey: "sk-test",
      client: {
        responses: {
          parse: vi.fn().mockResolvedValue({ output_parsed: null }),
        },
      } as never,
    });

    await expect(
      model.review({ title: "标题", body: "正文", version: 1 }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
  });
});
