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
    const usage = model.consumeLastUsage();
    expect(usage?.input_tokens).toBe(100);
    expect(usage?.cached_input_tokens).toBeNull();
    const provenance = model.consumeLastProvenance();
    expect(provenance?.attempt_count).toBe(1);
    expect(provenance?.aggregated_usage.cached_input_tokens_status).toBe("not_reported");
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
  });

  test("retries once on malformed JSON then passes", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "not-json" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      })
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const candidates = await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(candidates).toHaveLength(1);
    const provenance = model.consumeLastProvenance();
    expect(provenance?.attempt_count).toBe(2);
    expect(provenance?.aggregated_usage.input_tokens).toBe(30);
    expect(provenance?.aggregated_usage.input_tokens_completeness).toBe("complete");
    expect(provenance?.aggregated_usage.output_tokens).toBe(12);
    expect(provenance?.aggregated_usage.cached_input_tokens).toBe(5);
    expect(provenance?.aggregated_usage.cached_input_tokens_status).toBe("reported");
    expect(provenance?.aggregated_usage.cached_input_tokens_completeness).toBe("complete");
    expect(provenance?.observed_response_model).toBe("deepseek-v4-flash");
    expect(provenance?.attempts.every((item) => item.received_provider_response)).toBe(true);
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
    const provenance = model.consumeLastProvenance();
    expect(provenance?.attempt_count).toBe(2);
  });

  test("records observed response model separately from the requested model", async () => {
    const create = vi.fn().mockResolvedValue({
      model: "deepseek-other",
      choices: [{ message: { content: JSON.stringify(validOutput) } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    const provenance = model.consumeLastProvenance();
    expect(provenance?.requested_model).toBe("deepseek-v4-flash");
    expect(provenance?.observed_response_model).toBe("deepseek-other");
    expect(provenance?.observed_response_model_status).toBe("observed");
  });

  test("does not treat a thrown provider call as a received response", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network"));
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    await expect(
      model.review({ title: "标题", body: "座谈谈会", version: 1 }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    const provenance = model.consumeLastProvenance();
    expect(create).toHaveBeenCalledTimes(1);
    expect(provenance?.attempts).toHaveLength(1);
    expect(provenance?.attempts[0]?.received_provider_response).toBe(false);
    expect(provenance?.aggregated_usage.input_tokens).toBeNull();
    expect(provenance?.aggregated_usage.input_tokens_completeness).toBe("incomplete");
    expect(provenance?.observed_response_model).toBeNull();
    expect(provenance?.observed_response_model_status).toBe("not_reported");
  });

  test("does not report a complete usage total when an earlier retry attempt omits usage", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 3 } },
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    const provenance = model.consumeLastProvenance();
    expect(create).toHaveBeenCalledTimes(2);
    expect(provenance?.attempts[0]?.received_provider_response).toBe(true);
    expect(provenance?.attempts[0]?.usage).toBeNull();
    expect(provenance?.attempts[1]?.received_provider_response).toBe(true);
    expect(provenance?.aggregated_usage.input_tokens).toBeNull();
    expect(provenance?.aggregated_usage.input_tokens_completeness).toBe("incomplete");
    expect(provenance?.aggregated_usage.cached_input_tokens).toBeNull();
  });
});
