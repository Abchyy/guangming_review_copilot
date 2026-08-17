import { describe, expect, test, vi } from "vitest";

import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import { parseLlmReviewOutput, ReviewProviderError } from "@/lib/contracts/review";

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
      evidence: [{ kind: "ai_judgment", excerpt: "测试", citation_validated: false }],
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

describe("DeepSeek review model", () => {
  test("uses json_object, disables thinking, and validates schema", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validOutput) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });

    const candidates = await model.review({
      title: "标题",
      body: "座谈谈会",
      version: 1,
    });

    expect(model.model).toBe("deepseek-v4-flash");
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]?.[0] as {
      model: string;
      response_format: { type: string };
      extra_body: { thinking: { type: string } };
      messages: Array<{ content: string }>;
    };
    expect(arg.model).toBe("deepseek-v4-flash");
    expect(arg.response_format).toEqual({ type: "json_object" });
    expect(arg.extra_body.thinking.type).toBe("disabled");
    expect(arg.messages[0]?.content.toLowerCase()).toContain("json");
    expect(parseLlmReviewOutput({ candidates }).candidates).toHaveLength(1);
    expect(model.consumeLastUsage()?.input_tokens).toBe(100);
  });

  test("retries once on malformed JSON then passes", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: "not-json" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const candidates = await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(candidates).toHaveLength(1);
  });

  test("rejects empty content after retry", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    await expect(
      model.review({ title: "标题", body: "正文", version: 1 }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
