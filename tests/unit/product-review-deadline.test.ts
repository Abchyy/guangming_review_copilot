import { describe, expect, test } from "vitest";

import { ReviewProviderError, WEB_EVIDENCE_UNVERIFIED_MESSAGE } from "@grc/contracts";
import type { ReviewCandidate } from "@grc/contracts";
import { FixtureReviewModel, type ReviewModel } from "@grc/providers";
import {
  PRODUCT_MAIN_REVIEW_BUDGET_MS,
  PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS,
  PRODUCT_REVIEW_DEADLINE_MS,
  PRODUCT_REVIEW_MAX_ATTEMPTS,
  PRODUCT_REVIEW_MAX_CANDIDATES,
  PRODUCT_REVIEW_MAX_ELAPSED_MS,
  PRODUCT_REVIEW_MAX_TOKENS,
  PRODUCT_REVIEW_SDK_MAX_RETRIES,
  PRODUCT_REVIEW_SETTLE_MS,
  PRODUCT_SPECIALIST_BUDGET_MS,
  PRODUCT_WEB_EVIDENCE_BUDGET_MS,
  createReview,
  productAbortAtMs,
  productPhaseBudgetMs,
} from "@grc/review-core";
import type { ReviewPromptContext } from "@grc/providers";
import { createModelSpecialists, createSpecialistRuntime } from "@grc/agent-orchestration";
import {
  FakeSearchProvider,
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

class IgnoreAbortReviewModel implements ReviewModel {
  readonly provider = "deepseek" as const;
  readonly model = "deepseek-v4-flash";
  calls = 0;

  review(): Promise<ReviewCandidate[]> {
    this.calls += 1;
    return new Promise(() => undefined);
  }
}

class FailingReviewModel implements ReviewModel {
  readonly provider = "deepseek" as const;
  readonly model = "deepseek-v4-flash";

  review(): Promise<ReviewCandidate[]> {
    return Promise.reject(new ReviewProviderError("DeepSeek provider unavailable"));
  }
}

describe("product review deadline", () => {
  test("product budget stays under the route cap", () => {
    expect(PRODUCT_REVIEW_DEADLINE_MS).toBe(470_000);
    expect(PRODUCT_REVIEW_DEADLINE_MS).toBeLessThan(PRODUCT_REVIEW_MAX_ELAPSED_MS);
    expect(PRODUCT_REVIEW_MAX_ELAPSED_MS).toBe(480_000);
    expect(PRODUCT_REVIEW_SETTLE_MS).toBeGreaterThan(0);
    expect(productAbortAtMs(PRODUCT_REVIEW_DEADLINE_MS)).toBeLessThan(PRODUCT_REVIEW_DEADLINE_MS);
    expect(productAbortAtMs(PRODUCT_REVIEW_DEADLINE_MS)).toBeGreaterThan(460_000);
    expect(PRODUCT_REVIEW_MAX_TOKENS).toBe(12_288);
    expect(PRODUCT_REVIEW_MAX_CANDIDATES).toBe(20);
    expect(PRODUCT_REVIEW_MAX_ATTEMPTS).toBe(2);
    expect(PRODUCT_REVIEW_SDK_MAX_RETRIES).toBe(0);
    expect(PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS).toBe(150_000);
    expect(
      PRODUCT_MAIN_REVIEW_BUDGET_MS +
        PRODUCT_WEB_EVIDENCE_BUDGET_MS +
        PRODUCT_SPECIALIST_BUDGET_MS,
    ).toBeLessThan(productAbortAtMs(PRODUCT_REVIEW_DEADLINE_MS));
    expect(productPhaseBudgetMs(PRODUCT_MAIN_REVIEW_BUDGET_MS, 5_000)).toBeLessThan(
      PRODUCT_MAIN_REVIEW_BUDGET_MS,
    );
  });

  test("product deadline path asks the main reviewer for expanded recoverable JSON", async () => {
    const seen: ReviewPromptContext[] = [];
    const model: ReviewModel = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      review(_article, context = {}) {
        seen.push(context);
        return Promise.resolve([]);
      },
    };
    await createReview(article, model, { deadlineMs: 5_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxTokens).toBe(PRODUCT_REVIEW_MAX_TOKENS);
    expect(seen[0]?.maxAttempts).toBe(PRODUCT_REVIEW_MAX_ATTEMPTS);
    expect(seen[0]?.maxRetries).toBe(PRODUCT_REVIEW_SDK_MAX_RETRIES);
    expect(seen[0]?.fallbackToTextJson).toBe(true);
    expect(seen[0]?.timeoutMs).toBeGreaterThan(0);
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(PRODUCT_MAIN_REVIEW_ATTEMPT_TIMEOUT_MS);
    expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(productPhaseBudgetMs(PRODUCT_MAIN_REVIEW_BUDGET_MS, 5_000));
  });

  test("official-style createReview without a deadline does not force a compact token cap", async () => {
    const seen: ReviewPromptContext[] = [];
    const model: ReviewModel = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      review(_article, context = {}) {
        seen.push(context);
        return Promise.resolve([]);
      },
    };
    await createReview(article, model);
    expect(seen[0]?.maxTokens).toBeUndefined();
    expect(seen[0]?.maxAttempts).toBeUndefined();
    expect(seen[0]?.maxRetries).toBeUndefined();
    expect(seen[0]?.fallbackToTextJson).toBeUndefined();
  });

  test("signal-only still forwards signal and timeout without a token cap", async () => {
    const seen: ReviewPromptContext[] = [];
    const model: ReviewModel = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      review(_article, context = {}) {
        seen.push(context);
        return Promise.resolve([]);
      },
    };
    const controller = new AbortController();
    await createReview(article, model, { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect("timeoutMs" in (seen[0] ?? {})).toBe(true);
    expect(seen[0]?.timeoutMs).toBeUndefined();
    expect(seen[0]?.maxTokens).toBeUndefined();
    expect(seen[0]?.maxAttempts).toBeUndefined();
    expect(seen[0]?.maxRetries).toBeUndefined();
    expect(seen[0]?.fallbackToTextJson).toBeUndefined();
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
    const provenance = result.pipeline.provenance;
    expect(provenance).toBeDefined();
    expect(provenance?.attempts[0]).toMatchObject({
      outcome: "retryable_failure",
      received_provider_response: false,
    });
    expect(provenance?.attempts[0]?.error).toBeTruthy();
    expect(provenance?.latency_ms).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("main-review failure still dispatches Tavily work and both specialists", async () => {
    const fallbackArticle = {
      title: "科技创新与爱国主义教育工作推进会召开",
      body: "2026年8月30日，材料称，“国家数据统计局”发布《2023年全国科技经费投入统计公报》。会议要求执行《中华人民共和国爱国主义教育法》。主持人宣读：“统计数据必须真实准确。”",
    };
    const collector = createWebEvidenceCollector(new FakeSearchProvider());
    let specialistCalls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        specialistCalls += 1;
        return Promise.resolve([]);
      },
    }));
    const result = await createReview(fallbackArticle, new FailingReviewModel(), {
      deadlineMs: 5_000,
      webEvidenceCollector: collector,
      specialistRuntime: createSpecialistRuntime(specialists),
    });

    expect(result.pipeline.fallback).toMatchObject({ used: true, mode: "rules_only" });
    expect(result.pipeline.web_evidence?.query_count).toBe(2);
    expect(result.pipeline.specialist_orchestration?.dispatched).toEqual([
      "fact_check",
      "news_edit",
    ]);
    expect(result.pipeline.specialist_orchestration?.budget.used).toBe(2);
    expect(specialistCalls).toBe(2);
    expect(result.findings.some((item) => item.type === "citation")).toBe(true);
    expect(result.findings.every((item) => item.status === "verify")).toBe(true);
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
      deadlineMs: 400,
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

  test("a pre-aborted signal never starts model, Tavily, or specialist calls", async () => {
    const model = new IgnoreAbortReviewModel();
    let searches = 0;
    const collector = createWebEvidenceCollector(
      new TavilySearchProvider({
        apiKey: "tvly-test-key",
        fetchImpl: () => {
          searches += 1;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      }),
    );
    let specialistCalls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        specialistCalls += 1;
        return Promise.resolve([]);
      },
    }));
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await createReview(article, model, {
      deadlineMs: 5_000,
      signal: controller.signal,
      webEvidenceCollector: collector,
      specialistRuntime: createSpecialistRuntime(specialists),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.pipeline.elapsed_ms).toBeLessThanOrEqual(5_000);
    expect(model.calls).toBe(0);
    expect(searches).toBe(0);
    expect(specialistCalls).toBe(0);
    expect(result.pipeline.fallback?.mode).toBe("rules_only");
    expect(result.pipeline.web_evidence?.query_count).toBe(0);
    expect(result.pipeline.web_evidence?.results).toEqual([]);
    expect(result.pipeline.specialist_orchestration?.budget.used).toBe(0);
    expect(result.pipeline.specialist_orchestration?.dispatched).toEqual([]);
    expect(
      result.pipeline.specialist_orchestration?.results.every(
        (item) =>
          item.provenance.invoked === false &&
          item.provenance.status === "not_invoked" &&
          item.provenance.attempt_count === 0,
      ),
    ).toBe(true);
  });

  test("a main-review timeout preserves downstream web and specialist budgets", async () => {
    const model = new IgnoreAbortReviewModel();
    let searches = 0;
    const collector = createWebEvidenceCollector(
      new TavilySearchProvider({
        apiKey: "tvly-test-key",
        timeoutMs: 8_000,
        fetchImpl: () =>
          new Promise(() => {
            searches += 1;
          }),
      }),
    );
    let specialistCalls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        specialistCalls += 1;
        return new Promise(() => undefined);
      },
    }));
    const deadlineMs = 80;
    const started = Date.now();
    const result = await createReview(article, model, {
      deadlineMs,
      webEvidenceCollector: collector,
      specialistRuntime: createSpecialistRuntime(specialists),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.pipeline.elapsed_ms).toBeLessThanOrEqual(deadlineMs);
    expect(model.calls).toBe(1);
    expect(searches).toBeGreaterThan(0);
    expect(specialistCalls).toBeGreaterThan(0);
    expect(result.pipeline.fallback?.mode).toBe("rules_only");
    expect(result.pipeline.web_evidence?.query_count).toBeGreaterThan(0);
    expect(result.pipeline.specialist_orchestration?.budget.used).toBeGreaterThan(0);
    expect(
      result.pipeline.specialist_orchestration?.results.every(
        (item) => item.provenance.invoked === true && item.provenance.status === "timed_out",
      ),
    ).toBe(true);
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
