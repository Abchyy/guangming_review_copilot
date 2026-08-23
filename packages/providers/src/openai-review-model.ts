import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  openaiLlmReviewOutputSchema,
  parseLlmReviewOutput,
  ReviewProviderError,
  type CanonicalArticle,
  type ReviewCandidate,
  type ReviewExecutionProvenance,
} from "@grc/contracts";
import { getReviewModelName } from "./config";
import {
  attemptRecord,
  buildHttpProvenance,
  extractObservedUsage,
  observedString,
  projectUsage,
} from "./provenance";
import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
} from "./prompt";
import type { ProviderCallUsage, ReviewModel, ReviewPromptContext } from "./review-model";

type OpenAIReviewModelOptions = {
  apiKey?: string;
  model?: string;
  client?: OpenAI;
};

type OpenAIParseClient = {
  responses: {
    parse: (params: Record<string, unknown>) => Promise<{
      model?: string | null;
      output_parsed?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        prompt_tokens_details?: { cached_tokens?: number };
      };
    }>;
  };
};

export class OpenAIReviewModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAIParseClient;
  private lastUsage: ProviderCallUsage | null = null;
  private lastProvenance: ReviewExecutionProvenance | null = null;

  constructor(options: OpenAIReviewModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!options.client && !apiKey) {
      throw new ReviewProviderError("OPENAI_API_KEY is missing");
    }

    this.model = options.model ?? getReviewModelName("openai");
    this.client = (options.client ??
      new OpenAI({
        apiKey,
      })) as unknown as OpenAIParseClient;
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
    let observedModel: string | null = null;
    let usage = null as ReturnType<typeof extractObservedUsage>;
    let receivedProviderResponse = false;

    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: buildReviewSystemPrompt(context) },
          {
            role: "user",
            content: buildReviewUserPrompt(article.title, article.body, context),
          },
        ],
        text: {
          format: zodTextFormat(openaiLlmReviewOutputSchema, "review_candidates"),
        },
      });
      receivedProviderResponse = true;
      observedModel = observedString(response.model);
      usage = extractObservedUsage(response.usage);
      const parsed = response.output_parsed;
      if (parsed == null) {
        const error = new ReviewProviderError("Provider response failed schema validation");
        this.commitAttempts(startedAt, [
          attemptRecord({
            attempt: 1,
            outcome: "fatal_failure",
            requestedModel: this.model,
            observedResponseModel: observedModel,
            receivedProviderResponse,
            usage,
            error,
          }),
        ]);
        throw error;
      }

      const candidates = parseLlmReviewOutput(parsed).candidates;
      this.commitAttempts(startedAt, [
        attemptRecord({
          attempt: 1,
          outcome: "success",
          requestedModel: this.model,
          observedResponseModel: observedModel,
          receivedProviderResponse,
          usage,
          error: null,
        }),
      ]);
      return candidates;
    } catch (error) {
      if (this.lastProvenance == null) {
        const wrapped =
          error instanceof ReviewProviderError
            ? error
            : new ReviewProviderError("OpenAI provider unavailable", error);
        this.commitAttempts(startedAt, [
          attemptRecord({
            attempt: 1,
            outcome: "fatal_failure",
            requestedModel: this.model,
            observedResponseModel: observedModel,
            receivedProviderResponse,
            usage,
            error: wrapped,
          }),
        ]);
        throw wrapped;
      }
      if (error instanceof ReviewProviderError) {
        throw error;
      }
      throw new ReviewProviderError("OpenAI provider unavailable", error);
    }
  }

  private commitAttempts(
    startedAt: number,
    attempts: ReviewExecutionProvenance["attempts"],
  ): void {
    this.lastProvenance = buildHttpProvenance({
      adapterProvider: this.provider,
      requestedModel: this.model,
      attempts,
      latencyMs: Date.now() - startedAt,
    });
    this.lastUsage = projectUsage(this.lastProvenance);
  }
}
