/** @vitest-environment node */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import {
  SPECIALIST_REQUEST_TIMEOUT_MS,
  SPECIALIST_TARGET_MODEL,
  createSpecialistRuntimeFromEnv,
} from "@grc/agent-orchestration";
import {
  aggregateCallSnapshots,
  averageMetrics,
  evaluateReview,
  snapshotFromProvenance,
  type BenchmarkMetrics,
  type GoldIssue,
} from "@grc/benchmark";
import type {
  CanonicalArticle,
  Finding,
  FindingType,
  ReviewExecutionProvenance,
  Severity,
} from "@grc/contracts";
import {
  OFFICIAL_BENCHMARK_MODEL,
  DeepSeekReviewModel,
  assertObservedModelMatchesExpected,
} from "@grc/providers";
import { PRODUCT_REVIEW_DEADLINE_MS, createReview } from "@grc/review-core";
import {
  CHALLENGE_LIVE_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "@grc/test-kit";
import { createWebEvidenceCollectorFromEnv } from "@grc/web-evidence";

type ChallengeArticle = {
  article_id: string;
  origin: "synthetic_from_public_facts" | "fully_synthetic";
  difficulty_tags: string[];
  title: string;
  body: string;
  issues: GoldIssue[];
};

type ChallengeDataset = {
  dataset_version: string;
  role: "adversarial_dev";
  official: false;
  may_claim_fresh_locked_generalization: false;
  articles: ChallengeArticle[];
};

type RecallBucket = { matched: number; gold: number; recall: number };

function loadChallengeDataset(): ChallengeDataset {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "data", "benchmark", "generalization-challenge-v1.json"),
      "utf8",
    ),
  ) as ChallengeDataset;
}

function reportPath(): string {
  return join(process.cwd(), ".data", "generalization-challenge-v1-last-run.json");
}

function canonicalArticle(article: ChallengeArticle): CanonicalArticle {
  return { title: article.title.trim(), body: article.body.trim(), version: 1 };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown live challenge failure";
}

function recallBuckets(
  totals: Map<string, { matched: number; gold: number }>,
): Record<string, RecallBucket> {
  return Object.fromEntries(
    [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, bucket]) => [
        name,
        {
          ...bucket,
          recall: bucket.gold === 0 ? 0 : bucket.matched / bucket.gold,
        },
      ]),
  );
}

function addBucket(
  totals: Map<string, { matched: number; gold: number }>,
  name: string,
  matched: boolean,
): void {
  const bucket = totals.get(name) ?? { matched: 0, gold: 0 };
  bucket.gold += 1;
  bucket.matched += matched ? 1 : 0;
  totals.set(name, bucket);
}

describe("public adversarial generalization challenge (diagnostic, never official locked)", () => {
  let apiKey: string;
  let tavilyApiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      CHALLENGE_LIVE_INTENT,
      "Run `npm run test:challenge-live` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("DEEPSEEK_API_KEY");
    tavilyApiKey = requireEnvApiKey("TAVILY_API_KEY");
    expect(process.env.WEB_EVIDENCE_ENABLED).toBe("true");
    expect(process.env.REVIEW_SPECIALISTS_ENABLED).toBe("1");
  });

  test("runs 12 public/synthetic challenge articles through the full product path", async () => {
    const dataset = loadChallengeDataset();
    expect(dataset.role).toBe("adversarial_dev");
    expect(dataset.official).toBe(false);
    expect(dataset.may_claim_fresh_locked_generalization).toBe(false);
    expect(dataset.articles).toHaveLength(12);

    const rows: BenchmarkMetrics[] = [];
    const runtimes: ReturnType<typeof snapshotFromProvenance>[] = [];
    const articleReports: Array<Record<string, unknown>> = [];
    const executionFailures: Array<{ article_id: string; error: string }> = [];
    const rulesOnlyArticleIds: string[] = [];
    const typeTotals = new Map<FindingType, { matched: number; gold: number }>();
    const severityTotals = new Map<Severity, { matched: number; gold: number }>();
    let cleanControlFalsePositives = 0;
    let tavilyQueryCount = 0;
    let tavilyRetrievedCount = 0;
    let tavilyUnverifiedCount = 0;
    let specialistInvokedCount = 0;
    let specialistAttemptCount = 0;
    let specialistSucceededCount = 0;
    let specialistFailedCount = 0;
    let specialistTimedOutCount = 0;

    const webEvidenceCollector = createWebEvidenceCollectorFromEnv({
      env: {
        ...process.env,
        TAVILY_API_KEY: tavilyApiKey,
        WEB_EVIDENCE_ENABLED: "true",
      },
    });
    const specialistRuntime = createSpecialistRuntimeFromEnv(
      { ...process.env, REVIEW_SPECIALISTS_ENABLED: "1" },
      {
        clientFactory: () =>
          new DeepSeekReviewModel({
            apiKey,
            model: SPECIALIST_TARGET_MODEL,
            timeoutMs: SPECIALIST_REQUEST_TIMEOUT_MS,
          }),
      },
    );
    expect(webEvidenceCollector).not.toBeNull();
    expect(specialistRuntime).not.toBeNull();

    for (const article of dataset.articles) {
      const model = new DeepSeekReviewModel({ apiKey });
      const startedAt = Date.now();
      let canonical = canonicalArticle(article);
      let findings: Finding[] = [];
      let provenance: ReviewExecutionProvenance | null = null;
      let fallback: unknown = null;
      let pipelineCounts: Record<string, number> | null = null;
      let webEvidenceReport: unknown = null;
      let specialistReport: unknown = null;
      let executionError: string | null = null;

      try {
        const snapshot = await createReview(
          { title: article.title, body: article.body },
          model,
          {
            promptMode: "copilot",
            useCache: false,
            deadlineMs: PRODUCT_REVIEW_DEADLINE_MS,
            webEvidenceCollector,
            specialistRuntime,
          },
        );
        canonical = snapshot.article;
        findings = snapshot.findings;
        provenance = snapshot.pipeline.provenance ?? null;
        fallback = snapshot.pipeline.fallback ?? null;
        pipelineCounts = {
          dropped_count: snapshot.pipeline.dropped_count,
          candidate_count: snapshot.pipeline.candidate_count,
          located_count: snapshot.pipeline.located_count,
        };
        const webEvidence = snapshot.pipeline.web_evidence;
        webEvidenceReport = webEvidence ?? null;
        if (webEvidence) {
          tavilyQueryCount += webEvidence.query_count;
          tavilyRetrievedCount += webEvidence.results.filter(
            (result) => result.status === "retrieved",
          ).length;
          tavilyUnverifiedCount += webEvidence.results.filter(
            (result) => result.status === "unverified",
          ).length;
        }
        const specialistRun = snapshot.pipeline.specialist_orchestration;
        specialistReport = specialistRun ?? null;
        if (specialistRun) {
          specialistInvokedCount += specialistRun.results.filter(
            (result) => result.provenance.invoked,
          ).length;
          specialistAttemptCount += specialistRun.results.reduce(
            (sum, result) => sum + result.provenance.attempt_count,
            0,
          );
          specialistSucceededCount += specialistRun.results.filter(
            (result) => result.provenance.status === "succeeded",
          ).length;
          specialistFailedCount += specialistRun.results.filter(
            (result) => result.provenance.status === "failed",
          ).length;
          specialistTimedOutCount += specialistRun.results.filter(
            (result) => result.provenance.status === "timed_out",
          ).length;
        }
        if (snapshot.pipeline.fallback?.used) {
          rulesOnlyArticleIds.push(article.article_id);
        }
      } catch (error) {
        executionError = safeError(error);
        executionFailures.push({ article_id: article.article_id, error: executionError });
        provenance = model.consumeLastProvenance();
      }

      if (provenance) {
        if (provenance.adapter_provider !== "deepseek") {
          throw new Error(`Unexpected adapter provider: ${provenance.adapter_provider}`);
        }
        if (provenance.observed_response_model_status === "observed") {
          assertObservedModelMatchesExpected(provenance, OFFICIAL_BENCHMARK_MODEL);
        }
        const runtime = snapshotFromProvenance(provenance);
        runtimes.push(runtime);
      }

      const evaluated = evaluateReview(canonical, findings, article.issues);
      const matchedGoldIds = new Set(evaluated.matches.map((match) => match.gold_id));
      for (const issue of article.issues) {
        const matched = matchedGoldIds.has(issue.issue_id);
        addBucket(typeTotals, issue.type, matched);
        addBucket(severityTotals, issue.severity, matched);
      }
      if (article.issues.length === 0) {
        cleanControlFalsePositives += evaluated.unmatchedFindingIds.length;
      }

      const runtime = provenance ? snapshotFromProvenance(provenance) : null;
      rows.push({
        ...evaluated.metrics,
        latency_ms: runtime?.latency_ms ?? Date.now() - startedAt,
        cost_usd: runtime?.cost_usd ?? null,
      });
      articleReports.push({
        article_id: article.article_id,
        origin: article.origin,
        difficulty_tags: article.difficulty_tags,
        gold_count: article.issues.length,
        finding_count: findings.length,
        counts: {
          tp: evaluated.matches.length,
          fp: evaluated.unmatchedFindingIds.length,
          fn: evaluated.unmatchedGold.length,
        },
        metrics: evaluated.metrics,
        matched_gold_ids: [...matchedGoldIds],
        unmatched_gold_ids: evaluated.unmatchedGold,
        unmatched_findings: findings
          .filter((finding) => evaluated.unmatchedFindingIds.includes(finding.finding_id))
          .map((finding) => ({
            finding_id: finding.finding_id,
            type: finding.type,
            severity: finding.severity,
            title: finding.title,
            quoted_text: finding.source_span.quoted_text,
          })),
        fallback,
        pipeline_counts: pipelineCounts,
        web_evidence: webEvidenceReport,
        specialist_orchestration: specialistReport,
        execution_error: executionError,
        provenance,
        runtime,
      });
    }

    const payload = {
      dataset: dataset.dataset_version,
      role: dataset.role,
      claim: "public_adversarial_diagnostic",
      diagnostic_only: true,
      official: false,
      may_claim_fresh_locked_generalization: false,
      article_ids: dataset.articles.map((article) => article.article_id),
      gold_issues: dataset.articles.reduce((sum, article) => sum + article.issues.length, 0),
      clean_control_articles: dataset.articles.filter((article) => article.issues.length === 0).length,
      clean_control_false_positives: cleanControlFalsePositives,
      expected_provider: "deepseek",
      expected_model: OFFICIAL_BENCHMARK_MODEL,
      product_deadline_ms: PRODUCT_REVIEW_DEADLINE_MS,
      deepseek_attempt_policy: "product_default",
      web_evidence_enabled: true,
      specialists_enabled: true,
      metrics: averageMetrics(rows),
      runtime: aggregateCallSnapshots(runtimes),
      tavily: {
        query_count: tavilyQueryCount,
        retrieved_count: tavilyRetrievedCount,
        unverified_count: tavilyUnverifiedCount,
      },
      specialists: {
        invoked_count: specialistInvokedCount,
        attempt_count: specialistAttemptCount,
        succeeded_count: specialistSucceededCount,
        failed_count: specialistFailedCount,
        timed_out_count: specialistTimedOutCount,
      },
      recall_by_type: recallBuckets(typeTotals),
      recall_by_severity: recallBuckets(severityTotals),
      rules_only_article_ids: rulesOnlyArticleIds,
      execution_failures: executionFailures,
      articles: articleReports,
    };

    mkdirSync(join(process.cwd(), ".data"), { recursive: true });
    writeFileSync(reportPath(), `${JSON.stringify(payload, null, 2)}\n`);

    expect(payload.article_ids).toHaveLength(12);
    expect(payload.gold_issues).toBe(36);
    expect(payload.runtime.application_cache.hit).toBe(false);
    expect(payload.web_evidence_enabled).toBe(true);
    expect(payload.specialists_enabled).toBe(true);
    expect(payload.official).toBe(false);
    expect(payload.may_claim_fresh_locked_generalization).toBe(false);
  }, 900_000);
});
