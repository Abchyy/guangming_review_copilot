import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadBenchmarkDataset } from "@/lib/server/benchmark/dataset";
import { averageMetrics, evaluateReview, type BenchmarkMetrics } from "@/lib/server/benchmark/evaluate";
import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import { estimateDeepSeekCostUsd } from "@/lib/server/llm/deepseek-pricing";
import { PROMPT_VERSION } from "@/lib/server/llm/prompt";
import { getCorpusVersion } from "@/lib/server/quality/corpus";
import { getRuleVersion } from "@/lib/server/quality/rules";
import { createReview } from "@/lib/server/review-service";

const apiKey = process.env.DEEPSEEK_API_KEY;

function reportPath(): string {
  return join(process.cwd(), ".data", "m3-benchmark-last-run.json");
}

describe.skipIf(!apiKey)("M3 primary benchmark (domestic model)", () => {
  test("compares baseline prompt vs copilot on locked eval once", async () => {
    const dataset = loadBenchmarkDataset();
    const locked = dataset.articles.filter((item) => item.split === "locked");
    expect(locked).toHaveLength(12);

    async function runSplit(
      mode: "baseline" | "copilot",
    ): Promise<{ metrics: BenchmarkMetrics; contamination: string[] }> {
      const rows: BenchmarkMetrics[] = [];
      const contamination: string[] = [];
      for (const article of locked) {
        const model = new DeepSeekReviewModel({ apiKey });
        const started = Date.now();
        const snapshot = await createReview(
          { title: article.title, body: article.body },
          model,
          { promptMode: mode, useCache: false },
        );
        const usage = model.consumeLastUsage?.() ?? null;
        const evaluated = evaluateReview(snapshot.article, snapshot.findings, article.issues);
        if (evaluated.goldLocateFailures.length > 0) {
          contamination.push(`${article.article_id}: gold locate failed`);
        }
        rows.push({
          ...evaluated.metrics,
          latency_ms: usage?.latency_ms ?? Date.now() - started,
          cost_usd: usage ? estimateDeepSeekCostUsd(usage) : null,
        });
      }
      return { metrics: averageMetrics(rows), contamination };
    }

    const baseline = await runSplit("baseline");
    const copilot = await runSplit("copilot");
    const payload = {
      dataset: dataset.dataset_version,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseline_prompt: PROMPT_VERSION,
      copilot_versions: {
        prompt: PROMPT_VERSION,
        rules: getRuleVersion(),
        corpus: getCorpusVersion(),
      },
      baseline: baseline.metrics,
      copilot: copilot.metrics,
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

describe("benchmark dataset freeze", () => {
  test("dataset file remains 6 dev / 12 locked", () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "data/benchmark/dataset.json"), "utf8"),
    ) as { articles: Array<{ split: string }> };
    expect(raw.articles.filter((item) => item.split === "dev")).toHaveLength(6);
    expect(raw.articles.filter((item) => item.split === "locked")).toHaveLength(12);
  });
});
