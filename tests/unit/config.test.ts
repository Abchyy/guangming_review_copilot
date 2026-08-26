import { describe, expect, test } from "vitest";

import { isSpecialistOrchestrationEnabled } from "@grc/agent-orchestration";
import {
  DEFAULT_PRODUCTION_MODEL,
  getReviewModelName,
  getReviewProvider,
  specialistsEnabled,
} from "@grc/providers";
import { getTavilyApiKey, isWebEvidenceEnabled } from "@grc/web-evidence";

describe("review provider configuration", () => {
  test("defaults to fixture and does not require OpenAI", () => {
    expect(getReviewProvider()).toBe("fixture");
    expect(getReviewModelName("deepseek")).toBe(DEFAULT_PRODUCTION_MODEL);
    expect(getReviewModelName("openai")).toBe("gpt-5.6-terra");
  });

  test("web evidence live search stays off without key and enable flag", () => {
    expect(getTavilyApiKey()).toBeUndefined();
    expect(isWebEvidenceEnabled()).toBe(false);
  });

  test("specialist orchestration stays off without an explicit enable flag", () => {
    expect(specialistsEnabled()).toBe(false);
    expect(isSpecialistOrchestrationEnabled()).toBe(false);
  });
});
