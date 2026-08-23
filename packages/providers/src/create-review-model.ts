import { getReviewProvider } from "./config";
import { DeepSeekReviewModel } from "./deepseek-review-model";
import { FixtureReviewModel } from "./fixture-review-model";
import { OpenAIReviewModel } from "./openai-review-model";
import type { ReviewModel } from "./review-model";

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
