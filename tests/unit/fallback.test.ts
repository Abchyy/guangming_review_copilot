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

class EmptyResponseModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model = "test-model";
  review(): Promise<ReviewCandidate[]> {
    return Promise.reject(new ReviewProviderError("Provider response was empty"));
  }
}

class InvalidJsonModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model = "test-model";
  review(): Promise<ReviewCandidate[]> {
    return Promise.resolve([{ type: "nope" }] as unknown as ReviewCandidate[]);
  }
}

class FixtureLikeEmpty implements ReviewModel {
  readonly provider = "fixture" as const;
  readonly model = null;
  review(): Promise<ReviewCandidate[]> {
    return Promise.resolve([]);
  }
}

const noRuleHitsArticle = {
  title: "天气很好",
  body: "今天没有机构、政策名称或可触发规则的错误。",
};

async function withFallbackMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.REVIEW_FALLBACK_MODE;
  if (mode === undefined) {
    delete process.env.REVIEW_FALLBACK_MODE;
  } else {
    process.env.REVIEW_FALLBACK_MODE = mode;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.REVIEW_FALLBACK_MODE;
    } else {
      process.env.REVIEW_FALLBACK_MODE = previous;
    }
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

  test("copilot degrades to empty rules_only when provider fails with no rule hits", async () => {
    const unavailable = await createReview(noRuleHitsArticle, new FailingModel());
    expect(unavailable.pipeline.fallback?.used).toBe(true);
    expect(unavailable.pipeline.fallback?.mode).toBe("rules_only");
    expect(unavailable.pipeline.fallback?.reason).toContain("unavailable");
    expect(unavailable.findings).toEqual([]);

    const empty = await createReview(noRuleHitsArticle, new EmptyResponseModel());
    expect(empty.pipeline.fallback?.used).toBe(true);
    expect(empty.pipeline.fallback?.mode).toBe("rules_only");
    expect(empty.pipeline.fallback?.reason).toContain("empty");
    expect(empty.findings).toEqual([]);

    const invalid = await createReview(noRuleHitsArticle, new InvalidJsonModel());
    expect(invalid.pipeline.fallback?.used).toBe(true);
    expect(invalid.pipeline.fallback?.mode).toBe("rules_only");
    expect(invalid.findings).toEqual([]);
  });

  test("baseline mode does not invent results when the provider fails", async () => {
    await expect(
      createReview(article, new FailingModel(), { promptMode: "baseline" }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    await expect(
      createReview(noRuleHitsArticle, new EmptyResponseModel(), { promptMode: "baseline" }),
    ).rejects.toBeInstanceOf(ReviewProviderError);
    await expect(
      createReview(noRuleHitsArticle, new InvalidJsonModel(), { promptMode: "baseline" }),
    ).rejects.toThrow(/schema validation/);
  });

  test("FALLBACK_MODE=fail still throws instead of degrading", async () => {
    await withFallbackMode("fail", async () => {
      await expect(createReview(article, new FailingModel())).rejects.toBeInstanceOf(
        ReviewProviderError,
      );
      await expect(
        createReview(noRuleHitsArticle, new EmptyResponseModel()),
      ).rejects.toBeInstanceOf(ReviewProviderError);
      await expect(createReview(noRuleHitsArticle, new InvalidJsonModel())).rejects.toThrow(
        /schema validation/,
      );
    });
  });

  test("fixture provider is not used as a silent stand-in for live failure", async () => {
    const fixture = await createReview(article, new FixtureLikeEmpty());
    const degraded = await createReview(article, new FailingModel());
    expect(degraded.pipeline.fallback?.used).toBe(true);
    expect(fixture.pipeline.fallback?.used ?? false).toBe(false);
    expect(degraded.pipeline.provider).toBe("openai");
  });
});
