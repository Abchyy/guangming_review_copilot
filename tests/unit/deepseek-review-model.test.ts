import { describe, expect, test, vi } from "vitest";

import {
  DeepSeekReviewModel,
  DEEPSEEK_RETRY_POLICY,
  PRODUCT_JSON_COMPACT_INSTRUCTION,
} from "@grc/providers";
import { parseLlmReviewOutput, ReviewProviderError } from "@grc/contracts";

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
  test("completeJson sends the supplied prompts and does not inject a full article", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validOutput) } }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const candidates = await model.completeJson({
      system: "事实核验专家",
      user: "quote=市教育局局长王海涛",
    });
    expect(candidates).toHaveLength(1);
    const arg = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(arg.messages[0]?.content).toContain("事实核验专家");
    expect(arg.messages[1]?.content).toBe("quote=市教育局局长王海涛");
    expect(arg.messages.some((item) => item.content.includes("【正文】"))).toBe(false);
  });

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
      max_tokens: number;
      response_format: { type: string };
      thinking: { type: string };
      stream: boolean;
      messages: Array<{ content: string }>;
    };
    expect(arg.model).toBe("deepseek-v4-flash");
    expect(arg.max_tokens).toBe(DEEPSEEK_RETRY_POLICY.max_tokens);
    expect(arg.response_format).toEqual({ type: "json_object" });
    expect(arg.thinking.type).toBe("disabled");
    expect(arg.stream).toBe(false);
    expect(arg).not.toHaveProperty("extra_body");
    expect(create.mock.calls[0]?.[1]).toBeUndefined();
    expect(arg.messages[0]?.content.toLowerCase()).toContain("json");
    expect(arg.messages[0]?.content).not.toContain(PRODUCT_JSON_COMPACT_INSTRUCTION);
    expect(parseLlmReviewOutput({ candidates }).candidates).toHaveLength(1);
  });

  test("product review uses the expanded JSON budget without changing official retry max_tokens", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(validOutput) } }],
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    await model.review(
      { title: "标题", body: "座谈谈会", version: 1 },
      {
        maxTokens: 12_288,
        maxAttempts: 2,
        maxRetries: 0,
        fallbackToTextJson: true,
      },
    );
    const arg = create.mock.calls[0]?.[0] as {
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    expect(arg.max_tokens).toBe(12_288);
    expect(arg.messages[0]?.content).toContain(PRODUCT_JSON_COMPACT_INSTRUCTION);
    expect(arg.messages[0]?.content).toContain("最多输出 20 条");
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(DEEPSEEK_RETRY_POLICY.max_tokens).toBe(8192);
  });

  test("product review recovers from empty JSON mode with a plain-text JSON retry", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\`` } }],
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const candidates = await model.review(
      { title: "标题", body: "正文", version: 1 },
      {
        maxTokens: 12_288,
        maxAttempts: 2,
        maxRetries: 0,
        fallbackToTextJson: true,
      },
    );
    expect(candidates).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      max_tokens: 12_288,
      response_format: { type: "json_object" },
    });
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty("response_format");
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      max_tokens: 8192,
      thinking: { type: "disabled" },
      stream: false,
    });
    expect(create.mock.calls[1]?.[1]).toMatchObject({ maxRetries: 0 });
    const retryMessages = (create.mock.calls[1]?.[0] as { messages: Array<{ content: string }> })
      .messages;
    expect(retryMessages[0]?.content).toContain("上一次 JSON Output 未返回可解析内容");
    expect(model.consumeLastProvenance()?.attempt_count).toBe(2);
  });

  test("treats a length-truncated JSON response as retryable and switches to compact recovery", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ finish_reason: "length", message: { content: '{"candidates":[' } }],
        usage: { prompt_tokens: 100, completion_tokens: 12_288 },
      })
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validOutput) } }],
        usage: { prompt_tokens: 110, completion_tokens: 500 },
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });

    const candidates = await model.review(
      { title: "标题", body: "正文", version: 1 },
      {
        maxTokens: 12_288,
        maxAttempts: 2,
        maxRetries: 0,
        fallbackToTextJson: true,
      },
    );

    expect(candidates).toHaveLength(1);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ max_tokens: 8192 });
    const retrySystem = (create.mock.calls[1]?.[0] as {
      messages: Array<{ content: string }>;
    }).messages[0]?.content;
    expect(retrySystem).toContain("紧凑恢复");
    expect(model.consumeLastProvenance()?.attempts[0]?.error).toBe(
      "Provider response JSON was truncated",
    );
  });

  test("repairs safe candidate shape differences and drops irreparable siblings", async () => {
    const repairable = {
      ...validOutput.candidates[0],
      confidence: "0.8",
      suggestion: { text: "建议人工核实" },
      evidence: [{ kind: "unsupported_kind", excerpt: "测试" }],
      source: {
        field: "body",
        quoted_text: "座谈谈会",
        paragraph_index: "0",
      },
    };
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ candidates: [repairable, { type: "unknown" }] }),
          },
        },
      ],
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });

    const candidates = await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      confidence: 0.8,
      suggestion: { text: "建议人工核实", replacement: null },
      evidence: [{ kind: "ai_judgment", excerpt: "测试", citation_validated: false }],
      source: {
        field: "body",
        exact_quote: "座谈谈会",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      },
    });
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
    expect(DEEPSEEK_RETRY_POLICY).toEqual({
      max_attempts: 2,
      timeout_ms: 60_000,
      max_tokens: 8192,
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 8192 });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ max_tokens: 8192 });
    expect(create.mock.calls[0]?.[0]).toHaveProperty("response_format");
    expect(create.mock.calls[1]?.[0]).toHaveProperty("response_format");
    expect(create.mock.calls[0]?.[1]).toBeUndefined();
    expect(create.mock.calls[1]?.[1]).toBeUndefined();
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
    expect(create).toHaveBeenCalledTimes(2);
    expect(provenance?.attempts).toHaveLength(2);
    expect(provenance?.attempts[0]?.received_provider_response).toBe(false);
    expect(provenance?.aggregated_usage.input_tokens).toBeNull();
    expect(provenance?.aggregated_usage.input_tokens_completeness).toBe("incomplete");
    expect(provenance?.observed_response_model).toBeNull();
    expect(provenance?.observed_response_model_status).toBe("not_reported");
  });

  test("retries an observable request timeout without hidden SDK retries", async () => {
    const timeout = Object.assign(new Error("Request timed out"), {
      name: "APIConnectionTimeoutError",
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });

    const candidates = await model.review(
      { title: "标题", body: "座谈谈会", version: 1 },
      { maxAttempts: 2, maxRetries: 0, timeoutMs: 150_000 },
    );

    expect(candidates).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0, timeout: 150_000 });
    const provenance = model.consumeLastProvenance();
    expect(provenance?.attempt_count).toBe(2);
    expect(provenance?.attempts[0]).toMatchObject({
      outcome: "retryable_failure",
      received_provider_response: false,
      error: "DeepSeek request timed out",
    });
    expect(provenance?.attempts[1]?.outcome).toBe("success");
  });

  test("records HTTP 429 distinctly before a bounded retry", async () => {
    const rateLimit = Object.assign(new Error("rate limit"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });

    await model.review(
      { title: "标题", body: "座谈谈会", version: 1 },
      { maxAttempts: 2, maxRetries: 0 },
    );

    expect(model.consumeLastProvenance()?.attempts[0]?.error).toBe(
      "DeepSeek rate limited (HTTP 429)",
    );
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

  test("specialist completeJson does not retry and forwards a smaller budget, timeout, and abort", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not-json" } }],
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const controller = new AbortController();
    await expect(
      model.completeJson({
        system: "事实核验专家",
        user: "quote=市教育局局长王海涛",
        maxAttempts: 1,
        maxRetries: 0,
        maxTokens: 2048,
        timeoutMs: 12_000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 2048 });
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      timeout: 12_000,
    });
    expect(create.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(DEEPSEEK_RETRY_POLICY.max_attempts).toBe(2);
    expect(DEEPSEEK_RETRY_POLICY.timeout_ms).toBe(60_000);
    expect(DEEPSEEK_RETRY_POLICY.max_tokens).toBe(8192);
  });

  test("an aborted review does not start a second official retry", async () => {
    const controller = new AbortController();
    const create = vi.fn((_body: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const started = Date.now();
    queueMicrotask(() => controller.abort());
    await expect(
      model.review(
        { title: "标题", body: "座谈谈会", version: 1 },
        { signal: controller.signal, timeoutMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(DEEPSEEK_RETRY_POLICY).toEqual({
      max_attempts: 2,
      timeout_ms: 60_000,
      max_tokens: 8192,
    });
  });

  test("specialist request timeout aborts the in-flight provider call instead of leaving it running", async () => {
    let aborted = false;
    const create = vi.fn(
      (_body: unknown, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }) => {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            aborted = true;
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    );
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      client: { chat: { completions: { create } } } as never,
    });
    const started = Date.now();
    await expect(
      model.completeJson({
        system: "事实核验专家",
        user: "quote=市教育局局长王海涛",
        maxAttempts: 1,
        maxRetries: 0,
        maxTokens: 2048,
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    expect(aborted).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      timeout: 25,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("review() keeps retrying after a retryable failure even when specialist overrides exist on the class", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: "" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validOutput) } }],
      });
    const model = new DeepSeekReviewModel({
      apiKey: "sk-test",
      timeoutMs: 12_000,
      client: { chat: { completions: { create } } } as never,
    });
    const candidates = await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    expect(candidates).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 8192 });
    expect(create.mock.calls[0]?.[1]).toBeUndefined();
    expect(create.mock.calls[1]?.[1]).toBeUndefined();
  });
});
