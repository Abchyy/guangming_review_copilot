/** @vitest-environment node */
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { loadBenchmarkDataset } from "@/lib/server/benchmark/dataset";
import { averageMetrics, evaluateReview, type BenchmarkMetrics } from "@/lib/server/benchmark/evaluate";
import { aggregateCallSnapshots, snapshotFromProvenance, type CallRuntimeSnapshot } from "@/lib/server/benchmark/runtime-report";
import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import { OFFICIAL_BENCHMARK_MODEL, assertOfficialBenchmarkProvenance } from "@/lib/server/llm/provenance";
import { PROMPT_VERSION } from "@/lib/server/llm/prompt";
import { getCorpusVersion } from "@/lib/server/quality/corpus";
import { getRuleVersion } from "@/lib/server/quality/rules";
import { createReview } from "@/lib/server/review-service";
import {
  LOCKED_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "../helpers/live-intent";

/**
 * Locked evaluation entry.
 * Start with `npm run test:locked`. An API key is not sufficient to start.
 * Existing locked numbers are not re-validated in this isolation repair.
 */
function reportPath(): string {
  return join(process.cwd(), ".data", "m3-benchmark-last-run.json");
}

describe("M3 locked evaluation (explicit opt-in only)", () => {
  let apiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      LOCKED_INTENT,
      "Run `npm run test:locked` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("DEEPSEEK_API_KEY");
  });

  test("compares baseline prompt vs copilot on locked eval once", async () => {
    const dataset = loadBenchmarkDataset();
    const locked = dataset.articles.filter((item) => item.split === "locked");
    expect(locked).toHaveLength(12);

    async function runSplit(
      mode: "baseline" | "copilot",
    ): Promise<{ metrics: BenchmarkMetrics; contamination: string[]; runtime: ReturnType<typeof aggregateCallSnapshots> }> {
      const rows: BenchmarkMetrics[] = [];
      const contamination: string[] = [];
      const runtimes: CallRuntimeSnapshot[] = [];
      for (const article of locked) {
        const model = new DeepSeekReviewModel({ apiKey });
        const snapshot = await createReview(
          { title: article.title, body: article.body },
          model,
          { promptMode: mode, useCache: false },
        );
        const provenance = snapshot.pipeline.provenance;
        if (!provenance) {
          throw new Error("Locked evaluation requires execution provenance");
        }
        assertOfficialBenchmarkProvenance(provenance);
        const runtime = snapshotFromProvenance(provenance);
        const evaluated = evaluateReview(snapshot.article, snapshot.findings, article.issues);
        if (evaluated.goldLocateFailures.length > 0) {
          contamination.push(`${article.article_id}: gold locate failed`);
        }
        rows.push({
          ...evaluated.metrics,
          latency_ms: runtime.latency_ms,
          cost_usd: runtime.cost_usd,
        });
        runtimes.push(runtime);
      }
      return { metrics: averageMetrics(rows), contamination, runtime: aggregateCallSnapshots(runtimes) };
    }

    const baseline = await runSplit("baseline");
    const copilot = await runSplit("copilot");
    const payload = {
      dataset: dataset.dataset_version,
      expected_provider: "deepseek",
      expected_model: OFFICIAL_BENCHMARK_MODEL,
      official: true,
      baseline_prompt: PROMPT_VERSION,
      copilot_versions: {
        prompt: PROMPT_VERSION,
        rules: getRuleVersion(),
        corpus: getCorpusVersion(),
      },
      baseline: {
        metrics: baseline.metrics,
        runtime: baseline.runtime,
      },
      copilot: {
        metrics: copilot.metrics,
        runtime: copilot.runtime,
      },
      contamination: [...baseline.contamination, ...copilot.contamination],
    };
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(process.cwd(), ".data"), { recursive: true });
      writeFileSync(reportPath(), `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      // report file is optional; metrics still assert below
    }

    if (payload.contamination.length > 0) {
      throw new Error(`CONTAMINATED: ${payload.contamination.join("; ")}`);
    }

    expect(copilot.metrics.critical_high_recall).toBeGreaterThanOrEqual(baseline.metrics.critical_high_recall);
    expect(copilot.metrics.overall_recall).toBeGreaterThanOrEqual(baseline.metrics.overall_recall);
    expect(copilot.metrics.precision).toBeGreaterThanOrEqual(baseline.metrics.precision - 0.05);
    expect(copilot.metrics.evidence_coverage).toBeGreaterThanOrEqual(0.8);
    expect(copilot.metrics.span_validation).toBeGreaterThanOrEqual(0.95);
    expect(copilot.metrics.top5_recall).toBeGreaterThanOrEqual(0.8);
  }, 900_000);
});
