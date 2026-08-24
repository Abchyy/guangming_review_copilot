import OpenAI from "openai";

import {
  parseLlmReviewOutput,
  ReviewProviderError,
  type CanonicalArticle,
  type ProviderAttempt,
  type ReviewCandidate,
  type ReviewExecutionProvenance,
} from "@grc/contracts";
import {
  observeOfficialProviderEndpoint,
  providerAccountBoundaryId,
} from "./official-endpoint";
import {
  getDeepSeekApiKey,
  getDeepSeekBaseUrl,
  getReviewModelName,
} from "./config";
import {
  attemptRecord,
  buildHttpProvenance,
  extractObservedUsage,
  observedString,
  OFFICIAL_BENCHMARK_MODEL,
  OFFICIAL_BENCHMARK_PROVIDER,
  projectUsage,
} from "./provenance";
import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
} from "./prompt";
import type {
  ProviderCallUsage,
  ReviewModel,
  ReviewPromptContext,
} from "./review-model";

const JSON_OUTPUT_INSTRUCTION = `你必须输出 json 对象，不要输出 Markdown 代码围栏。EXAMPLE JSON OUTPUT:
{"candidates":[{"type":"basic_text","severity":"low","title":"错别字","reason":"正文将座谈会写成座谈谈会。","suggestion":{"text":"改为座谈会。","replacement":"座谈会"},"confidence":0.9,"evidence":[{"kind":"ai_judgment","excerpt":"常见会议名称应为座谈会。","citation_validated":false}],"source":{"field":"body","exact_quote":"座谈谈会","paragraph_index":0,"context_before":null,"context_after":null}}]}`;

export const DEEPSEEK_RETRY_POLICY = {
  max_attempts: 2,
  timeout_ms: 60_000,
  max_tokens: 8192,
} as const;

const CANONICAL_OFFICIAL = Symbol("canonicalOfficialDeepSeek");

type DeepSeekReviewModelOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  client?: OpenAI;
  timeoutMs?: number;
  [CANONICAL_OFFICIAL]?: true;
};

export type OfficialDeepSeekExecutionBinding = {
  provider: "deepseek";
  requested_model: string;
  provider_endpoint: string;
  account_boundary_id: string;
};

type ChatCompletionsClient = {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<{
        model?: string | null;
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
    const status = Number((error as { status?: unknown }).status);
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
  readonly officialExecution: OfficialDeepSeekExecutionBinding | null;
  private readonly client: ChatCompletionsClient;
  private lastUsage: ProviderCallUsage | null = null;
  private lastProvenance: ReviewExecutionProvenance | null = null;

  constructor(options: DeepSeekReviewModelOptions = {}) {
    const apiKey = options.apiKey ?? getDeepSeekApiKey();
    if (!options.client && !apiKey) {
      throw new ReviewProviderError("DEEPSEEK_API_KEY is missing");
    }

    this.model = options.model ?? getReviewModelName("deepseek");
    const baseURL = options.baseURL ?? getDeepSeekBaseUrl();
    this.client = (options.client ??
      new OpenAI({
        apiKey,
        baseURL,
        timeout: options.timeoutMs ?? DEEPSEEK_RETRY_POLICY.timeout_ms,
      })) as unknown as ChatCompletionsClient;
    this.officialExecution =
      options[CANONICAL_OFFICIAL] && !options.client && apiKey
        ? {
            provider: "deepseek",
            requested_model: this.model,
            provider_endpoint: baseURL,
            account_boundary_id: providerAccountBoundaryId(OFFICIAL_BENCHMARK_PROVIDER, apiKey),
          }
        : null;
  }

  static createCanonicalOfficial(): DeepSeekReviewModel {
    const apiKey = getDeepSeekApiKey();
    if (!apiKey) {
      throw new ReviewProviderError("DEEPSEEK_API_KEY is missing");
    }
    return new DeepSeekReviewModel({
      apiKey,
      baseURL: observeOfficialProviderEndpoint(),
      model: OFFICIAL_BENCHMARK_MODEL,
      timeoutMs: DEEPSEEK_RETRY_POLICY.timeout_ms,
      [CANONICAL_OFFICIAL]: true,
    });
  }

  consumeLastUsage(): ProviderCallUsage | null {
    const usage = this.lastUsage;
    this.lastUsage = null;
    return usage;
  }

  consumeLastProvenance(): ReviewExecutionProvenance | null {
    const provenance = this.lastProvenance;
    this.lastProvenance = null;
    return provenance;
  }

  async review(
    article: CanonicalArticle,
    context: ReviewPromptContext = {},
  ): Promise<ReviewCandidate[]> {
    const startedAt = Date.now();
    const attempts: ProviderAttempt[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= DEEPSEEK_RETRY_POLICY.max_attempts; attempt += 1) {
      const result = await this.reviewOnce(article, context, attempt);
      attempts.push(result.attempt);
      if (result.ok) {
        this.commitProvenance(attempts, startedAt);
        return result.candidates;
      }
      lastError = result.error;
      if (attempt < DEEPSEEK_RETRY_POLICY.max_attempts && isRetryable(lastError)) {
        continue;
      }
      this.commitProvenance(attempts, startedAt);
      throw lastError instanceof ReviewProviderError
        ? lastError
        : new ReviewProviderError("DeepSeek provider unavailable", lastError);
    }

    this.commitProvenance(attempts, startedAt);
    throw lastError instanceof ReviewProviderError
      ? lastError
      : new ReviewProviderError("DeepSeek provider unavailable", lastError);
  }

  private commitProvenance(attempts: ProviderAttempt[], startedAt: number): void {
    this.lastProvenance = buildHttpProvenance({
      adapterProvider: this.provider,
      requestedModel: this.model,
      attempts,
      latencyMs: Date.now() - startedAt,
    });
    this.lastUsage = projectUsage(this.lastProvenance);
  }

  private async reviewOnce(
    article: CanonicalArticle,
    context: ReviewPromptContext,
    attempt: number,
  ): Promise<
    | { ok: true; candidates: ReviewCandidate[]; attempt: ProviderAttempt }
    | { ok: false; error: unknown; attempt: ProviderAttempt }
  > {
    let observedModel: string | null = null;
    let usage = null as ReturnType<typeof extractObservedUsage>;
    let receivedProviderResponse = false;

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
        max_tokens: DEEPSEEK_RETRY_POLICY.max_tokens,
        extra_body: { thinking: { type: "disabled" } },
      });
      receivedProviderResponse = true;
      observedModel = observedString(response.model);
      usage = extractObservedUsage(response.usage);
      const content = response.choices?.[0]?.message?.content;
      if (content == null || content.trim().length === 0) {
        const error = new ReviewProviderError("Provider response was empty");
        return {
          ok: false,
          error,
          attempt: attemptRecord({
            attempt,
            outcome: "retryable_failure",
            requestedModel: this.model,
            observedResponseModel: observedModel,
            receivedProviderResponse,
            usage,
            error,
          }),
        };
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch {
        const error = new ReviewProviderError("Provider response was not valid JSON");
        return {
          ok: false,
          error,
          attempt: attemptRecord({
            attempt,
            outcome: "retryable_failure",
            requestedModel: this.model,
            observedResponseModel: observedModel,
            receivedProviderResponse,
            usage,
            error,
          }),
        };
      }

      return {
        ok: true,
        candidates: parseLlmReviewOutput(parsedJson).candidates.slice(0, 20),
        attempt: attemptRecord({
          attempt,
          outcome: "success",
          requestedModel: this.model,
          observedResponseModel: observedModel,
          receivedProviderResponse,
          usage,
          error: null,
        }),
      };
    } catch (error) {
      const wrapped =
        error instanceof ReviewProviderError
          ? error
          : new ReviewProviderError("DeepSeek provider unavailable", error);
      return {
        ok: false,
        error: wrapped,
        attempt: attemptRecord({
          attempt,
          outcome: isRetryable(wrapped) ? "retryable_failure" : "fatal_failure",
          requestedModel: this.model,
          observedResponseModel: observedModel,
          receivedProviderResponse,
          usage,
          error: wrapped,
        }),
      };
    }
  }
}
