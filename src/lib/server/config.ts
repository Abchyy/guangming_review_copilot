import type { ReviewProvider } from "@/lib/contracts/review";

export const DEFAULT_PRODUCTION_MODEL = "deepseek-v4-flash";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_OPENAI_BENCHMARK_MODEL = "gpt-5.6-terra";

export function getReviewProvider(): ReviewProvider {
  const value = process.env.REVIEW_PROVIDER?.trim() || "fixture";
  if (value !== "fixture" && value !== "deepseek" && value !== "openai") {
    throw new Error(`Invalid REVIEW_PROVIDER: ${value}`);
  }
  return value;
}

export function getReviewModelName(provider: ReviewProvider = getReviewProvider()): string {
  const value = process.env.REVIEW_MODEL?.trim();
  if (value && value.length > 0) {
    return value;
  }
  if (provider === "openai") {
    return DEFAULT_OPENAI_BENCHMARK_MODEL;
  }
  return DEFAULT_PRODUCTION_MODEL;
}

export function getDeepSeekApiKey(): string | undefined {
  const value = process.env.DEEPSEEK_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function getDeepSeekBaseUrl(): string {
  const value = process.env.DEEPSEEK_BASE_URL?.trim();
  return value && value.length > 0 ? value : DEFAULT_DEEPSEEK_BASE_URL;
}
