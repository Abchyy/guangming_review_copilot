/** @vitest-environment node */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { loadBenchmarkDataset } from "@grc/benchmark";
import {
  averageMetrics,
  evaluateReview,
  type BenchmarkArticle,
  type BenchmarkMetrics,
  type GoldIssue,
} from "@grc/benchmark";
import type { Finding } from "@grc/contracts";
import { aggregateCallSnapshots, snapshotFromProvenance } from "@grc/benchmark";
import { DeepSeekReviewModel } from "@grc/providers";
import {
  OFFICIAL_BENCHMARK_MODEL,
  assertObservedModelMatchesExpected,
} from "@grc/providers";
import { PROMPT_VERSION } from "@grc/providers";
import { getCorpusVersion } from "@grc/retrieval";
import { getRuleVersion } from "@grc/rules-engine";
import { createReview } from "@grc/review-core";
import {
  DEV_LIVE_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "@grc/test-kit";

/**
 * Diagnostic / development live benchmark.
 * Results from this entry are not a locked quality result.
 * Start with `npm run test:dev-live`. An API key is not sufficient to start.
 */
function reportPath(): string {
  return join(process.cwd(), ".data", "m3-dev-benchmark-last-run.json");
}

function classifyOrigin(finding: Finding): "rule" | "retrieval" | "llm" | "fused" {
  const kinds = new Set(finding.evidence.map((item) => item.kind));
  const hasRule = kinds.has("rule");
  const hasRetrieval = kinds.has("retrieved_source");
  const hasLlm = kinds.has("ai_judgment") || kinds.has("internal_context");
  if (hasRule && (hasRetrieval || hasLlm)) {
    return "fused";
  }
  if (hasRetrieval && hasLlm) {
    return "fused";
  }
  if (hasRule) {
    return "rule";
  }
  if (hasRetrieval) {
    return "retrieval";
  }
  return "llm";
}

function summarizeFinding(finding: Finding, rank: number) {
  return {
    finding_id: finding.finding_id,
    rank,
    type: finding.type,
    severity: finding.severity,
    field: finding.source_span.field,
    quoted_text: finding.source_span.quoted_text,
    title: finding.title,
    reason: finding.reason,
    origin: classifyOrigin(finding),
    evidence_kinds: finding.evidence.map((item) => item.kind),
    rule_ids: finding.evidence.map((item) => item.rule_id).filter((item): item is string => Boolean(item)),
    source_ids: finding.evidence.map((item) => item.source_id).filter((item): item is string => Boolean(item)),
    requires_verification: Boolean(finding.requires_verification),
  };
}

function summarizeGold(issue: GoldIssue) {
  return {
    issue_id: issue.issue_id,
    type: issue.type,
    severity: issue.severity,
    field: issue.field,
    quoted_text: issue.quoted_text,
    requires_evidence: issue.requires_evidence,
  };
}

describe("M3 development benchmark (diagnostic, not locked quality)", () => {
  let apiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      DEV_LIVE_INTENT,
      "Run `npm run test:dev-live` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("DEEPSEEK_API_KEY");
  });

  test("compares baseline prompt vs copilot on the 6-article dev split", async () => {
    const dataset = loadBenchmarkDataset();
    const articles = dataset.articles.filter((item) => item.split === "dev");
    expect(articles).toHaveLength(6);
    if (articles.some((item) => item.split !== "dev")) {
      throw new Error("Refusing to run: non-dev article leaked into development split");
    }

    async function runArticles(
      mode: "baseline" | "copilot",
      selected: BenchmarkArticle[],
    ) {
      const rows: BenchmarkMetrics[] = [];
      const contamination: string[] = [];
      const articleReports = [];
      const runtimes = [];

      for (const article of selected) {
        const model = new DeepSeekReviewModel({ apiKey });
        const snapshot = await createReview(
          { title: article.title, body: article.body },
          model,
          { promptMode: mode, useCache: false },
        );
        const provenance = snapshot.pipeline.provenance;
        if (!provenance) {
          throw new Error("Dev-live benchmark requires execution provenance");
        }
        if (provenance.adapter_provider !== "deepseek") {
          throw new Error(`Unexpected adapter provider: ${provenance.adapter_provider}`);
        }
        assertObservedModelMatchesExpected(provenance, OFFICIAL_BENCHMARK_MODEL);
        const runtime = snapshotFromProvenance(provenance);
        runtimes.push(runtime);
        const evaluated = evaluateReview(snapshot.article, snapshot.findings, article.issues);
        if (evaluated.goldLocateFailures.length > 0) {
          contamination.push(`${article.article_id}: gold locate failed`);
        }
        const goldById = new Map(article.issues.map((issue) => [issue.issue_id, issue]));
        const findingById = new Map(snapshot.findings.map((finding) => [finding.finding_id, finding]));
        rows.push({
          ...evaluated.metrics,
          latency_ms: runtime.latency_ms,
          cost_usd: runtime.cost_usd,
        });
        articleReports.push({
          article_id: article.article_id,
          split: article.split,
          gold: article.issues.map(summarizeGold),
          findings: snapshot.findings.map((finding, index) => summarizeFinding(finding, index + 1)),
          matches: evaluated.matches.map((match) => {
            const gold = goldById.get(match.gold_id);
            const finding = findingById.get(match.finding_id);
            return {
              ...match,
              gold_type: gold?.type ?? null,
              gold_severity: gold?.severity ?? null,
              finding_type: finding?.type ?? null,
              finding_severity: finding?.severity ?? null,
              finding_origin: finding ? classifyOrigin(finding) : null,
              finding_rank: finding
                ? snapshot.findings.findIndex((item) => item.finding_id === finding.finding_id) + 1
                : null,
            };
          }),
          unmatched_gold: evaluated.unmatchedGold.map((id) => summarizeGold(goldById.get(id)!)),
          unmatched_findings: evaluated.unmatchedFindingIds.map((id) => {
            const finding = findingById.get(id)!;
            const rank = snapshot.findings.findIndex((item) => item.finding_id === id) + 1;
            return summarizeFinding(finding, rank);
          }),
          gold_locate_failures: evaluated.goldLocateFailures,
          dropped_count: snapshot.pipeline.dropped_count,
          candidate_count: snapshot.pipeline.candidate_count,
          located_count: snapshot.pipeline.located_count,
          counts: {
            tp: evaluated.matches.length,
            fp: evaluated.unmatchedFindingIds.length,
            fn: evaluated.unmatchedGold.length,
          },
          metrics: {
            ...evaluated.metrics,
            latency_ms: runtime.latency_ms,
            cost_usd: runtime.cost_usd,
          },
          provenance,
          runtime,
        });
      }

      return {
        metrics: averageMetrics(rows),
        contamination,
        articles: articleReports,
        runtime: aggregateCallSnapshots(runtimes),
      };
    }

    const baseline = await runArticles("baseline", articles);
    const copilot = await runArticles("copilot", articles);
    const payload = {
      dataset: dataset.dataset_version,
      split: "dev",
      article_ids: articles.map((item) => item.article_id),
      gold_issues: articles.reduce((sum, item) => sum + item.issues.length, 0),
      expected_provider: "deepseek",
      expected_model: OFFICIAL_BENCHMARK_MODEL,
      diagnostic_only: true,
      official: false,
      baseline_prompt: PROMPT_VERSION,
      copilot_versions: {
        prompt: PROMPT_VERSION,
        rules: getRuleVersion(),
        corpus: getCorpusVersion(),
      },
      baseline: {
        metrics: baseline.metrics,
        runtime: baseline.runtime,
        articles: baseline.articles,
      },
      copilot: {
        metrics: copilot.metrics,
        runtime: copilot.runtime,
        articles: copilot.articles,
      },
      contamination: [...baseline.contamination, ...copilot.contamination],
    };

    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(reportPath(), `${JSON.stringify(payload, null, 2)}\n`);

    if (payload.contamination.length > 0) {
      throw new Error(`CONTAMINATED: ${payload.contamination.join("; ")}`);
    }

    expect(payload.split).toBe("dev");
    expect(payload.article_ids).toHaveLength(6);
    expect(baseline.runtime.logical_calls).toBe(6);
    expect(copilot.runtime.logical_calls).toBe(6);
    expect(baseline.runtime.application_cache.hit).toBe(false);
    expect(copilot.runtime.application_cache.hit).toBe(false);
  }, 900_000);
});
