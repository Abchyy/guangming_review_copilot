import { describe, expect, test } from "vitest";

import {
  DEFAULT_PRODUCTION_MODEL,
  getReviewModelName,
  getReviewProvider,
} from "@grc/providers";

describe("review provider configuration", () => {
  test("defaults to fixture and does not require OpenAI", () => {
    expect(getReviewProvider()).toBe("fixture");
    expect(getReviewModelName("deepseek")).toBe(DEFAULT_PRODUCTION_MODEL);
    expect(getReviewModelName("openai")).toBe("gpt-5.6-terra");
  });
});
