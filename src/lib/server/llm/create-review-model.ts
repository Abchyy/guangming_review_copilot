import { getReviewProvider } from "@/lib/server/config";
import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import { OpenAIReviewModel } from "@/lib/server/llm/openai-review-model";
import type { ReviewModel } from "@/lib/server/llm/review-model";

export function createReviewModelFromEnv(): ReviewModel {
  const provider = getReviewProvider();
  if (provider === "deepseek") {
    return new DeepSeekReviewModel();
  }
  if (provider === "openai") {
    return new OpenAIReviewModel();
  }
  return new FixtureReviewModel();
}
