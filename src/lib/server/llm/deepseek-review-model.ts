import OpenAI from "openai";

import {
  parseLlmReviewOutput,
  ReviewProviderError,
  type CanonicalArticle,
  type ReviewCandidate,
} from "@/lib/contracts/review";
import {
  getDeepSeekApiKey,
  getDeepSeekBaseUrl,
  getReviewModelName,
} from "@/lib/server/config";
import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
} from "@/lib/server/llm/prompt";
import type {
  ProviderCallUsage,
  ReviewModel,
  ReviewPromptContext,
} from "@/lib/server/llm/review-model";

const JSON_OUTPUT_INSTRUCTION = `你必须输出 json 对象，不要输出 Markdown 代码围栏。EXAMPLE JSON OUTPUT:
{"candidates":[{"type":"basic_text","severity":"low","title":"错别字","reason":"正文将座谈会写成座谈谈会。","suggestion":{"text":"改为座谈会。","replacement":"座谈会"},"confidence":0.9,"evidence":[{"kind":"ai_judgment","excerpt":"常见会议名称应为座谈会。","citation_validated":false}],"source":{"field":"body","exact_quote":"座谈谈会","paragraph_index":0,"context_before":null,"context_after":null}}]}`;

type DeepSeekReviewModelOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  client?: OpenAI;
  timeoutMs?: number;
};

type ChatCompletionsClient = {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<{
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      }>;
    };
  };
};

function isRetryable(error: unknown): boolean {
  if (error instanceof ReviewProviderError) {
    return (
      error.message.includes("schema") ||
      error.message.includes("empty") ||
      error.message.includes("JSON")
    );
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: number }).status);
    if (status === 401 || status === 403 || status === 400) {
      return false;
    }
    return status >= 500 || status === 429 || status === 408;
  }
  return true;
}

export class DeepSeekReviewModel implements ReviewModel {
  readonly provider = "deepseek" as const;
  readonly model: string;
  private readonly client: ChatCompletionsClient;
  private lastUsage: ProviderCallUsage | null = null;

  constructor(options: DeepSeekReviewModelOptions = {}) {
    const apiKey = options.apiKey ?? getDeepSeekApiKey();
    if (!options.client && !apiKey) {
      throw new ReviewProviderError("DEEPSEEK_API_KEY is missing");
    }

    this.model = options.model ?? getReviewModelName("deepseek");
    this.client = (options.client ??
      new OpenAI({
        apiKey,
        baseURL: options.baseURL ?? getDeepSeekBaseUrl(),
        timeout: options.timeoutMs ?? 60_000,
      })) as unknown as ChatCompletionsClient;
  }

  consumeLastUsage(): ProviderCallUsage | null {
    const usage = this.lastUsage;
    this.lastUsage = null;
    return usage;
  }

  async review(
    article: CanonicalArticle,
    context: ReviewPromptContext = {},
  ): Promise<ReviewCandidate[]> {
    const startedAt = Date.now();
    try {
      return await this.reviewOnce(article, context, startedAt);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error instanceof ReviewProviderError
          ? error
          : new ReviewProviderError("DeepSeek provider unavailable", error);
      }
      try {
        return await this.reviewOnce(article, context, startedAt);
      } catch (retryError) {
        if (retryError instanceof ReviewProviderError) {
          throw retryError;
        }
        throw new ReviewProviderError("DeepSeek provider unavailable", retryError);
      }
    }
  }

  private async reviewOnce(
    article: CanonicalArticle,
    context: ReviewPromptContext,
    startedAt: number,
  ): Promise<ReviewCandidate[]> {
    let content: string | null | undefined;
    let usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    } | undefined;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: `${buildReviewSystemPrompt(context)}\n\n${JSON_OUTPUT_INSTRUCTION}`,
          },
          {
            role: "user",
            content: buildReviewUserPrompt(article.title, article.body, context),
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 8192,
        extra_body: { thinking: { type: "disabled" } },
      });
      content = response.choices?.[0]?.message?.content;
      usage = response.usage;
    } catch (error) {
      if (error instanceof ReviewProviderError) {
        throw error;
      }
      throw new ReviewProviderError("DeepSeek provider unavailable", error);
    }

    this.lastUsage = {
      input_tokens: usage?.prompt_tokens ?? null,
      output_tokens: usage?.completion_tokens ?? null,
      cached_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
      latency_ms: Date.now() - startedAt,
    };

    if (content == null || content.trim().length === 0) {
      throw new ReviewProviderError("Provider response was empty");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new ReviewProviderError("Provider response was not valid JSON");
    }

    return parseLlmReviewOutput(parsedJson).candidates.slice(0, 20);
  }
}
