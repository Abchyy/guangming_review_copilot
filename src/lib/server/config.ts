export const DEFAULT_REVIEW_MODEL = "gpt-5.6-terra";

export function getReviewProvider(): "fixture" | "openai" {
  const value = process.env.REVIEW_PROVIDER?.trim() || "fixture";
  if (value !== "fixture" && value !== "openai") {
    throw new Error(`Invalid REVIEW_PROVIDER: ${value}`);
  }
  return value;
}

export function getReviewModelName(): string {
  const value = process.env.REVIEW_MODEL?.trim();
  return value && value.length > 0 ? value : DEFAULT_REVIEW_MODEL;
}
