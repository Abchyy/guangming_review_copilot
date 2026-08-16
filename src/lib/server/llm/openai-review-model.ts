import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  llmReviewOutputSchema,
  parseLlmReviewOutput,
  ReviewProviderError,
  type CanonicalArticle,
  type ReviewCandidate,
} from "@/lib/contracts/review";
import { getReviewModelName } from "@/lib/server/config";
import {
  buildReviewUserPrompt,
  REVIEW_SYSTEM_PROMPT,
} from "@/lib/server/llm/prompt";
import type { ReviewModel } from "@/lib/server/llm/review-model";

type OpenAIReviewModelOptions = {
  apiKey?: string;
  model?: string;
  client?: OpenAI;
};

export class OpenAIReviewModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIReviewModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!options.client && !apiKey) {
      throw new ReviewProviderError("OPENAI_API_KEY is missing");
    }

    this.model = options.model ?? getReviewModelName();
    this.client =
      options.client ??
      new OpenAI({
        apiKey,
      });
  }

  async review(article: CanonicalArticle): Promise<ReviewCandidate[]> {
    let parsed: unknown;

    try {
      const response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: REVIEW_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildReviewUserPrompt(article.title, article.body),
          },
        ],
        text: {
          format: zodTextFormat(llmReviewOutputSchema, "review_candidates"),
        },
      });
      parsed = response.output_parsed;
    } catch (error) {
      if (error instanceof ReviewProviderError) {
        throw error;
      }
      throw new ReviewProviderError("OpenAI provider unavailable", error);
    }

    if (parsed == null) {
      throw new ReviewProviderError("Provider response failed schema validation");
    }

    return parseLlmReviewOutput(parsed).candidates;
  }
}
