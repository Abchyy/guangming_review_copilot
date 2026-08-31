import OpenAI from "openai";

import {
  parseLlmReviewOutput,
  reviewCandidateSchema,
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
  SpecialistJsonCompletion,
} from "./review-model";

const JSON_OUTPUT_INSTRUCTION = `你必须输出 json 对象，不要输出 Markdown 代码围栏。EXAMPLE JSON OUTPUT:
{"candidates":[{"type":"basic_text","severity":"low","title":"错别字","reason":"正文将座谈会写成座谈谈会。","suggestion":{"text":"改为座谈会。","replacement":"座谈会"},"confidence":0.9,"evidence":[{"kind":"ai_judgment","excerpt":"常见会议名称应为座谈会。","citation_validated":false}],"source":{"field":"body","exact_quote":"座谈谈会","paragraph_index":0,"context_before":null,"context_after":null}}]}`;

/** Product-only. Official holdout review() omits maxTokens and does not append this. */
export const PRODUCT_JSON_COMPACT_INSTRUCTION =
  "必须输出完整闭合的 json。按风险从高到低最多输出 20 条 candidates；已有规则命中的 basic_text 不要重复。每条 title 不超过 18 字，reason 不超过 90 字，suggestion.text 不超过 60 字；只保留 1 项最有用的 evidence，excerpt 不超过 60 字；exact_quote 不超过 50 字，除非原文有重名歧义，否则 context_before/context_after 必须为 null。不要重复问题，不要复述全文，不要输出 schema 以外的文字。";

const TEXT_JSON_RETRY_INSTRUCTION =
  '上一次 JSON Output 未返回可解析内容。本次执行紧凑恢复：只输出风险最高且互不重复的 12 条问题；每条只保留定位、简短理由、简短建议和 1 项证据。不要使用 Markdown 代码围栏，不要输出前言或空白铺垫，直接从 {"candidates":[ 开始，并务必用 ]} 闭合完整 JSON。';

const RETRY_MAX_TOKENS = 8192;

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

type ChatCompletionRequestOptions = {
  signal?: AbortSignal;
  maxRetries?: number;
  timeout?: number;
};

function buildChatRequestOptions(options: {
  signal?: AbortSignal;
  maxRetries?: number;
  timeoutMs?: number;
}): {
  requestOptions: ChatCompletionRequestOptions | undefined;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const requestOptions: ChatCompletionRequestOptions = {};
  const localController = options.timeoutMs != null ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onParentAbort = () => localController?.abort();

  if (localController && options.timeoutMs != null) {
    if (options.signal?.aborted) {
      localController.abort();
    } else {
      options.signal?.addEventListener("abort", onParentAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      localController.abort();
    }, options.timeoutMs);
    requestOptions.signal = localController.signal;
    requestOptions.timeout = options.timeoutMs;
  } else if (options.signal) {
    requestOptions.signal = options.signal;
  }

  if (options.maxRetries != null) {
    requestOptions.maxRetries = options.maxRetries;
  }

  return {
    requestOptions: Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
    cleanup: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onParentAbort);
    },
    didTimeout: () => timedOut,
  };
}

type ChatCompletionsClient = {
  chat: {
    completions: {
      create: (
        params: Record<string, unknown>,
        options?: ChatCompletionRequestOptions,
      ) => Promise<{
        model?: string | null;
        choices?: Array<{
          finish_reason?: string | null;
          message?: { content?: string | null; reasoning_content?: string | null };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      }>;
    };
  };
};

function isAbortError(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  if (typeof error === "object" && "name" in error) {
    const name = String((error as { name?: unknown }).name);
    if (name === "AbortError" || name === "APIUserAbortError") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted|AbortError/i.test(message)) {
    return true;
  }
  if (error instanceof ReviewProviderError && error.cause) {
    return isAbortError(error.cause);
  }
  return false;
}

function providerFailureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 429) {
      return "DeepSeek rate limited (HTTP 429)";
    }
    if (status === 408) {
      return "DeepSeek request timed out (HTTP 408)";
    }
    if (status >= 500 && status <= 599) {
      return `DeepSeek upstream error (HTTP ${status})`;
    }
  }
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(`${name} ${message}`)) {
    return "DeepSeek request timed out";
  }
  if (isAbortError(error)) {
    return "DeepSeek request aborted";
  }
  if (/connection|network|fetch|socket|ECONN|ENOTFOUND/i.test(`${name} ${message}`)) {
    return "DeepSeek network connection failed";
  }
  return "DeepSeek provider unavailable";
}

function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ReviewProviderError) {
    if (error.message.includes("request timed out")) {
      return true;
    }
    if (error.cause && isAbortError(error.cause)) {
      return false;
    }
    if (error.cause) {
      return isRetryable(error.cause);
    }
    return (
      error.message.includes("schema") ||
      error.message.includes("empty") ||
      error.message.includes("JSON") ||
      error.message.includes("output budget")
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

function parseJsonContent(content: string): unknown {
  let normalized = content.trim();
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    normalized = fenced[1].trim();
  }
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace > 0 || (lastBrace >= 0 && lastBrace < normalized.length - 1)) {
    normalized = normalized.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(normalized);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedCandidate(raw: unknown): unknown {
  const candidate = recordOf(raw);
  if (!candidate) {
    return raw;
  }
  const reason = typeof candidate.reason === "string" ? candidate.reason : "需要人工核实。";
  const suggestion = recordOf(candidate.suggestion);
  const source = recordOf(candidate.source);
  const rawEvidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const evidence = rawEvidence.map((item) => {
    const entry = recordOf(item);
    if (!entry) {
      return {
        kind: "ai_judgment",
        excerpt: reason,
        citation_validated: false,
      };
    }
    const allowedKinds = new Set(["rule", "internal_context", "retrieved_source", "ai_judgment"]);
    return {
      ...entry,
      kind: allowedKinds.has(String(entry.kind)) ? entry.kind : "ai_judgment",
      excerpt: typeof entry.excerpt === "string" ? entry.excerpt : reason,
      citation_validated: entry.citation_validated === true,
    };
  });
  const confidenceValue =
    typeof candidate.confidence === "number"
      ? candidate.confidence
      : Number(candidate.confidence);
  const paragraphValue =
    typeof source?.paragraph_index === "number"
      ? source.paragraph_index
      : Number(source?.paragraph_index);

  return {
    ...candidate,
    confidence: Number.isFinite(confidenceValue)
      ? Math.min(1, Math.max(0, confidenceValue))
      : 0.5,
    suggestion: {
      ...suggestion,
      text:
        typeof suggestion?.text === "string" && suggestion.text.length > 0
          ? suggestion.text
          : reason,
      replacement:
        typeof suggestion?.replacement === "string" ? suggestion.replacement : null,
    },
    evidence:
      evidence.length > 0
        ? evidence
        : [{ kind: "ai_judgment", excerpt: reason, citation_validated: false }],
    source: {
      ...source,
      exact_quote:
        typeof source?.exact_quote === "string"
          ? source.exact_quote
          : source?.quoted_text,
      paragraph_index:
        Number.isInteger(paragraphValue) && paragraphValue >= 0 ? paragraphValue : 0,
      context_before: typeof source?.context_before === "string" ? source.context_before : null,
      context_after: typeof source?.context_after === "string" ? source.context_after : null,
    },
  };
}

function parseProviderCandidates(data: unknown): ReviewCandidate[] {
  const root = recordOf(data);
  if (!root || !Array.isArray(root.candidates)) {
    return parseLlmReviewOutput(data).candidates;
  }
  if (root.candidates.length === 0) {
    return [];
  }
  const candidates = root.candidates
    .map(normalizedCandidate)
    .map((candidate) => reviewCandidateSchema.safeParse(candidate))
    .filter((candidate) => candidate.success)
    .map((candidate) => candidate.data);
  if (candidates.length === 0) {
    throw new ReviewProviderError("Provider response failed schema validation");
  }
  return candidates.slice(0, 20);
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
    const system = buildReviewSystemPrompt(context);
    return this.completeJson({
      system:
        context.maxTokens != null
          ? `${system}\n\n${PRODUCT_JSON_COMPACT_INSTRUCTION}`
          : system,
      user: buildReviewUserPrompt(article.title, article.body, context),
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      maxTokens: context.maxTokens,
      maxAttempts: context.maxAttempts,
      maxRetries: context.maxRetries,
      fallbackToTextJson: context.fallbackToTextJson,
    });
  }

  async completeJson(input: SpecialistJsonCompletion): Promise<ReviewCandidate[]> {
    const startedAt = Date.now();
    const attempts: ProviderAttempt[] = [];
    let lastError: unknown;
    const maxAttempts = input.maxAttempts ?? DEEPSEEK_RETRY_POLICY.max_attempts;
    const maxTokens = input.maxTokens ?? DEEPSEEK_RETRY_POLICY.max_tokens;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal?.aborted) {
        lastError = new ReviewProviderError("DeepSeek provider unavailable");
        break;
      }
      const result = await this.completeOnce(input.system, input.user, attempt, {
        signal: input.signal,
        maxRetries: input.maxRetries,
        maxTokens: attempt > 1 ? Math.min(maxTokens, RETRY_MAX_TOKENS) : maxTokens,
        timeoutMs: input.timeoutMs,
        useJsonMode: !(input.fallbackToTextJson === true && attempt > 1),
        compactRetry: attempt > 1,
      });
      attempts.push(result.attempt);
      if (result.ok) {
        this.commitProvenance(attempts, startedAt);
        return result.candidates;
      }
      lastError = result.error;
      if (attempt < maxAttempts && isRetryable(lastError) && !input.signal?.aborted) {
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

  private async completeOnce(
    system: string,
    user: string,
    attempt: number,
    options: {
      signal?: AbortSignal;
      maxRetries?: number;
      maxTokens: number;
      timeoutMs?: number;
      useJsonMode: boolean;
      compactRetry: boolean;
    },
  ): Promise<
    | { ok: true; candidates: ReviewCandidate[]; attempt: ProviderAttempt }
    | { ok: false; error: unknown; attempt: ProviderAttempt }
  > {
    let observedModel: string | null = null;
    let usage = null as ReturnType<typeof extractObservedUsage>;
    let receivedProviderResponse = false;
    const { requestOptions, cleanup, didTimeout } = buildChatRequestOptions(options);

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          {
            role: "system",
            content: `${system}\n\n${JSON_OUTPUT_INSTRUCTION}${
              options.compactRetry ? `\n\n${TEXT_JSON_RETRY_INSTRUCTION}` : ""
            }`,
          },
          {
            role: "user",
            content: user,
          },
        ],
        max_tokens: options.maxTokens,
        thinking: { type: "disabled" },
        stream: false,
      };
      if (options.useJsonMode) {
        body.response_format = { type: "json_object" };
      }
      const response = await (requestOptions
        ? this.client.chat.completions.create(body, requestOptions)
        : this.client.chat.completions.create(body));
      receivedProviderResponse = true;
      observedModel = observedString(response.model);
      usage = extractObservedUsage(response.usage);
      const choice = response.choices?.[0];
      const content = choice?.message?.content;
      if (content == null || content.trim().length === 0) {
        const error = new ReviewProviderError(
          choice?.finish_reason === "length"
            ? "Provider exhausted output budget before returning content"
            : "Provider response was empty",
        );
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
        parsedJson = parseJsonContent(content);
      } catch {
        const error = new ReviewProviderError(
          choice?.finish_reason === "length"
            ? "Provider response JSON was truncated"
            : "Provider response was not valid JSON",
        );
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
        candidates: parseProviderCandidates(parsedJson),
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
          : new ReviewProviderError(
              didTimeout() ? "DeepSeek request timed out" : providerFailureMessage(error),
              error,
            );
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
    } finally {
      cleanup();
    }
  }
}
