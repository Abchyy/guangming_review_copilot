/** @vitest-environment node */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import {
  aggregateCallSnapshots,
  averageMetrics,
  evaluateReview,
  loadBenchmarkDataset,
  selectRegressionArticles,
  snapshotFromProvenance,
  type BenchmarkMetrics,
} from "@grc/benchmark";
import {
  OFFICIAL_BENCHMARK_MODEL,
  DeepSeekReviewModel,
  assertObservedModelMatchesExpected,
} from "@grc/providers";
import {
  PRODUCT_REVIEW_DEADLINE_MS,
  createReview,
} from "@grc/review-core";
import {
  REGRESSION_LIVE_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "@grc/test-kit";

function reportPath(): string {
  return join(process.cwd(), ".data", "m3-regression-benchmark-last-run.json");
}

describe("M3 contaminated regression benchmark (diagnostic, never official locked)", () => {
  let apiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      REGRESSION_LIVE_INTENT,
      "Run `npm run test:regression-live` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("DEEPSEEK_API_KEY");
  });

  test("runs the current copilot product path on the 12 former locked articles", async () => {
    const dataset = loadBenchmarkDataset();
    const articles = selectRegressionArticles(dataset);
    expect(articles).toHaveLength(12);
    expect(dataset.regression_contamination.may_claim_fresh_locked_generalization).toBe(false);

    const rows: BenchmarkMetrics[] = [];
    const runtimes = [];
    const articleReports = [];
    const goldLocateFailures: string[] = [];
    const rulesOnlyArticleIds: string[] = [];

    for (const article of articles) {
      const snapshot = await createReview(
        { title: article.title, body: article.body },
        new DeepSeekReviewModel({ apiKey }),
        {
          promptMode: "copilot",
          useCache: false,
          deadlineMs: PRODUCT_REVIEW_DEADLINE_MS,
        },
      );
      const provenance = snapshot.pipeline.provenance;
      if (!provenance) {
        throw new Error(`Regression article ${article.article_id} is missing provenance`);
      }
      if (provenance.adapter_provider !== "deepseek") {
        throw new Error(`Unexpected adapter provider: ${provenance.adapter_provider}`);
      }
      if (provenance.observed_response_model_status === "observed") {
        assertObservedModelMatchesExpected(provenance, OFFICIAL_BENCHMARK_MODEL);
      }

      const runtime = snapshotFromProvenance(provenance);
      const evaluated = evaluateReview(snapshot.article, snapshot.findings, article.issues);
      const fallback = snapshot.pipeline.fallback ?? {
        used: false,
        mode: "none" as const,
        reason: null,
      };
      runtimes.push(runtime);
      rows.push({
        ...evaluated.metrics,
        latency_ms: runtime.latency_ms,
        cost_usd: runtime.cost_usd,
      });
      if (fallback.used) {
        rulesOnlyArticleIds.push(article.article_id);
      }
      for (const failure of evaluated.goldLocateFailures) {
        goldLocateFailures.push(`${article.article_id}: ${failure}`);
      }
      articleReports.push({
        article_id: article.article_id,
        counts: {
          tp: evaluated.matches.length,
          fp: evaluated.unmatchedFindingIds.length,
          fn: evaluated.unmatchedGold.length,
        },
        metrics: evaluated.metrics,
        fallback,
        dropped_count: snapshot.pipeline.dropped_count,
        candidate_count: snapshot.pipeline.candidate_count,
        located_count: snapshot.pipeline.located_count,
        provenance,
        runtime,
      });
    }

    const payload = {
      dataset: dataset.dataset_version,
      split: "regression",
      claim: "regression_contaminated",
      diagnostic_only: true,
      official: false,
      may_claim_fresh_locked_generalization: false,
      article_ids: articles.map((article) => article.article_id),
      gold_issues: articles.reduce((sum, article) => sum + article.issues.length, 0),
      expected_provider: "deepseek",
      expected_model: OFFICIAL_BENCHMARK_MODEL,
      product_deadline_ms: PRODUCT_REVIEW_DEADLINE_MS,
      metrics: averageMetrics(rows),
      runtime: aggregateCallSnapshots(runtimes),
      rules_only_article_ids: rulesOnlyArticleIds,
      articles: articleReports,
      gold_locate_failures: goldLocateFailures,
    };

    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(reportPath(), `${JSON.stringify(payload, null, 2)}\n`);

    if (goldLocateFailures.length > 0) {
      throw new Error(`INVALID REGRESSION GOLD: ${goldLocateFailures.join("; ")}`);
    }
    expect(payload.article_ids).toHaveLength(12);
    expect(payload.runtime.logical_calls).toBe(12);
    expect(payload.runtime.application_cache.hit).toBe(false);
    expect(payload.official).toBe(false);
    expect(payload.may_claim_fresh_locked_generalization).toBe(false);
  }, 900_000);
});
