import { describe, expect, test } from "vitest";

import { ReviewProviderError, WEB_EVIDENCE_UNVERIFIED_MESSAGE } from "@grc/contracts";
import type { ReviewCandidate } from "@grc/contracts";
import { FixtureReviewModel, type ReviewModel } from "@grc/providers";
import {
  PRODUCT_REVIEW_DEADLINE_MS,
  PRODUCT_REVIEW_MAX_ELAPSED_MS,
  createReview,
} from "@grc/review-core";
import { createModelSpecialists, createSpecialistRuntime } from "@grc/agent-orchestration";
import {
  SearchProviderTimeoutError,
  TavilySearchProvider,
  createWebEvidenceCollector,
} from "@grc/web-evidence";

const article = {
  title: "学习教育强国建设规划纲要",
  body: "上周四（8月12日）召开座谈谈会。要学习《教育强国建设规划纲要（2023－2035年）》。",
};

class HangingReviewModel implements ReviewModel {
  readonly provider = "deepseek" as const;
  readonly model = "deepseek-v4-flash";
  calls = 0;
  aborted = false;

  review(
    _article: { title: string; body: string; version: number },
    context: { signal?: AbortSignal } = {},
  ): Promise<ReviewCandidate[]> {
    this.calls += 1;
    return new Promise((_, reject) => {
      const signal = context.signal;
      if (!signal) {
        return;
      }
      const fail = () => {
        this.aborted = true;
        reject(new ReviewProviderError("DeepSeek provider unavailable"));
      };
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  }
}

describe("product review deadline", () => {
  test("product budget stays under the route cap", () => {
    expect(PRODUCT_REVIEW_DEADLINE_MS).toBe(55_000);
    expect(PRODUCT_REVIEW_DEADLINE_MS).toBeLessThan(PRODUCT_REVIEW_MAX_ELAPSED_MS);
    expect(PRODUCT_REVIEW_MAX_ELAPSED_MS).toBe(60_000);
  });

  test("a hanging provider is aborted and degrades to rules_only under 60s", async () => {
    const model = new HangingReviewModel();
    const started = Date.now();
    const result = await createReview(article, model, { deadlineMs: 40 });
    expect(model.aborted).toBe(true);
    expect(model.calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.pipeline.elapsed_ms).toBeLessThan(PRODUCT_REVIEW_MAX_ELAPSED_MS);
    expect(result.pipeline.fallback?.used).toBe(true);
    expect(result.pipeline.fallback?.mode).toBe("rules_only");
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("deadline aborts remaining web evidence fetches and returns 未能外部核验", async () => {
    let fetches = 0;
    let aborted = false;
    const hangingFetch: typeof fetch = (_input, init) => {
      fetches += 1;
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        const fail = () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      });
    };
    const collector = createWebEvidenceCollector(
      new TavilySearchProvider({
        apiKey: "tvly-test-key",
        timeoutMs: 8_000,
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        fetchImpl: hangingFetch,
      }),
    );
    const started = Date.now();
    const result = await createReview(article, new FixtureReviewModel(), {
      deadlineMs: 40,
      webEvidenceCollector: collector,
    });
    expect(aborted).toBe(true);
    expect(fetches).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.pipeline.web_evidence?.results.every((item) => item.status === "unverified")).toBe(
      true,
    );
    expect(
      result.pipeline.web_evidence?.results.every((item) => item.message === WEB_EVIDENCE_UNVERIFIED_MESSAGE),
    ).toBe(true);
  });

  test("deadline aborts in-flight specialists and does not leave a hanging request", async () => {
    let calls = 0;
    let aborted = false;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson(input) {
        calls += 1;
        return new Promise<never>((_, reject) => {
          const signal = input.signal;
          const fail = () => {
            aborted = true;
            reject(new Error("aborted"));
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
      },
    }));
    const started = Date.now();
    const result = await createReview(article, new FixtureReviewModel(), {
      deadlineMs: 40,
      specialistRuntime: createSpecialistRuntime(specialists),
    });
    expect(aborted).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.pipeline.specialist_orchestration?.results.every((item) => item.provenance.status === "timed_out")).toBe(
      true,
    );
    expect(result.findings.some((item) => item.status === "verify")).toBe(true);
  });
});

describe("parent-aborted tavily search", () => {
  test("parent signal cancels the in-flight search", async () => {
    let aborted = false;
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    const controller = new AbortController();
    const search = new TavilySearchProvider({
      apiKey: "tvly-test-key",
      timeoutMs: 8_000,
      fetchImpl: hangingFetch,
    }).search(
      {
        query_text: "市教育局局长王海涛",
        fact_category: "person_title",
        allowed_domains: ["gov.cn"],
        language: "zh-CN",
        region: "CN",
        max_results: 3,
      },
      { signal: controller.signal },
    );
    const started = Date.now();
    queueMicrotask(() => controller.abort());
    await expect(search).rejects.toBeInstanceOf(SearchProviderTimeoutError);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
