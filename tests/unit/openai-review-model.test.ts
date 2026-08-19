import { describe, expect, test, vi } from "vitest";

import { OpenAIReviewModel } from "@/lib/server/llm/openai-review-model";
import { parseLlmReviewOutput, ReviewProviderError } from "@/lib/contracts/review";
import { getReviewModelName } from "@/lib/server/config";
import { snapshotFromProvenance } from "@/lib/server/benchmark/runtime-report";

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
      model: getReviewModelName("openai"),
      client: { responses: { parse } } as never,
    });

    const candidates = await model.review({
      title: "标题",
      body: "座谈谈会",
      version: 1,
    });

    expect(model.model).toBe(getReviewModelName("openai"));
    expect(parse).toHaveBeenCalledTimes(1);
    const arg = parse.mock.calls[0]?.[0] as {
      model: string;
      text: { format: { type?: string; name?: string } };
    };
    expect(arg.model).toBe(getReviewModelName("openai"));
    expect(arg.text.format).toBeTruthy();
    expect(parseLlmReviewOutput({ candidates }).candidates).toHaveLength(1);
    const provenance = model.consumeLastProvenance();
    expect(provenance?.adapter_provider).toBe("openai");
    expect(provenance?.requested_model).toBe(getReviewModelName("openai"));
    expect(provenance?.observed_response_model_status).toBe("not_reported");
    expect(provenance?.attempt_count).toBe(1);
  });

  test("does not apply DeepSeek runtime pricing to OpenAI provenance", async () => {
    const parse = vi.fn().mockResolvedValue({
      model: "gpt-5.4",
      output_parsed: validOutput,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const model = new OpenAIReviewModel({
      apiKey: "sk-test",
      model: getReviewModelName("openai"),
      client: { responses: { parse } } as never,
    });
    await model.review({ title: "标题", body: "座谈谈会", version: 1 });
    const provenance = model.consumeLastProvenance();
    const snapshot = snapshotFromProvenance(provenance!);
    expect(snapshot.adapter_provider).toBe("openai");
    expect(snapshot.cost_usd).toBeNull();
    expect(snapshot.cost_status).toBe("not_applicable");
    expect(snapshot.cost_cache_pricing).toBe("not_applicable");
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
