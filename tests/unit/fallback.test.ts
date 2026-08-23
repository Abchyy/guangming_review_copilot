import { describe, expect, test } from "vitest";

import { ReviewProviderError } from "@grc/contracts";
import type { ReviewCandidate } from "@grc/contracts";
import type { ReviewModel } from "@grc/providers";
import { createReview } from "@grc/review-core";

class FailingModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model = "test-model";
  review(): Promise<ReviewCandidate[]> {
    return Promise.reject(new ReviewProviderError("upstream unavailable"));
  }
}

class FixtureLikeEmpty implements ReviewModel {
  readonly provider = "fixture" as const;
  readonly model = null;
  review(): Promise<ReviewCandidate[]> {
    return Promise.resolve([]);
  }
}

describe("provider fallback", () => {
  const article = {
    title: "学习教育强国建设规划纲要",
    body: "上周四（8月12日）召开座谈谈会。要学习《教育强国建设规划纲要（2023－2035年）》。",
  };

  test("copilot mode degrades to rules_only and records provenance", async () => {
    const result = await createReview(article, new FailingModel());
    expect(result.pipeline.fallback?.used).toBe(true);
    expect(result.pipeline.fallback?.mode).toBe("rules_only");
    expect(result.pipeline.fallback?.reason).toContain("unavailable");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.pipeline.specialists_enabled).toBe(false);
    expect(
      result.findings.every((item) => item.evidence.every((ev) => ev.kind !== "ai_judgment")),
    ).toBe(true);
  });

  test("baseline mode does not invent results when the provider fails", async () => {
    await expect(
      createReview(article, new FailingModel(), { promptMode: "baseline" }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
  });

  test("fixture provider is not used as a silent stand-in for live failure", async () => {
    const fixture = await createReview(article, new FixtureLikeEmpty());
    const degraded = await createReview(article, new FailingModel());
    expect(degraded.pipeline.fallback?.used).toBe(true);
    expect(fixture.pipeline.fallback?.used ?? false).toBe(false);
    expect(degraded.pipeline.provider).toBe("openai");
  });
});
