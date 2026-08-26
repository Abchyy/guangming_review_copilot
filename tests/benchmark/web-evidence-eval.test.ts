import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  ALLOWED_SOURCE_CLASSES,
  EXPECTED_STATUSES,
  RISK_CATEGORIES,
  loadBenchmarkDataset,
  loadWebEvidenceDevDataset,
  scoreWebEvidenceDevRun,
  summarizeWebEvidenceDevCoverage,
  unevaluatedWebEvidenceDevScorecard,
  webEvidenceDevDatasetPath,
  type WebEvidenceDevCase,
  type WebEvidenceDevDataset,
  type WebEvidenceDevTrace,
} from "@grc/benchmark";

const BUDGET_ARTICLE_ID = "we-dev-art-budget";
const ALLOWED_OUTBOUND_FIELDS = [
  "claim_text",
  "normalized_fact",
  "as_of_date",
  "risk_category",
  "span_quote",
];

function goldAlignedTrace(item: WebEvidenceDevCase, triggered: boolean): WebEvidenceDevTrace {
  if (!triggered) {
    return {
      case_id: item.case_id,
      triggered: false,
      query_count: 0,
      query_text: null,
      outbound_fields: [],
      outbound_text_blobs: [],
      sources: [],
      status: "not_applicable",
      failure: null,
    };
  }
  return {
    case_id: item.case_id,
    triggered: true,
    query_count: 1,
    query_text: item.claim.normalized_fact,
    outbound_fields: [...ALLOWED_OUTBOUND_FIELDS],
    outbound_text_blobs: [item.claim.normalized_fact, item.claim.span_quote],
    sources: item.fixture_sources.map((source) => ({
      source_class: source.source_class,
      locator: source.locator,
      excerpt: source.excerpt,
    })),
    status: item.expected_status,
    failure: item.expected_failure ? { kind: item.expected_failure } : null,
  };
}

function goldAlignedTraces(dataset: WebEvidenceDevDataset): WebEvidenceDevTrace[] {
  const triggeredIds = new Set<string>();
  const byArticle = new Map<string, WebEvidenceDevCase[]>();
  for (const item of dataset.cases) {
    const list = byArticle.get(item.article_id) ?? [];
    list.push(item);
    byArticle.set(item.article_id, list);
  }
  for (const cases of byArticle.values()) {
    const ordered = [...cases].sort((a, b) => a.query_priority - b.query_priority || a.case_id.localeCompare(b.case_id));
    let used = 0;
    for (const item of ordered) {
      if (item.should_trigger_query && used < dataset.query_budget.max_queries_per_article) {
        triggeredIds.add(item.case_id);
        used += 1;
      }
    }
  }
  return dataset.cases.map((item) => goldAlignedTrace(item, triggeredIds.has(item.case_id)));
}

describe("web evidence development eval protocol", () => {
  const dataset = loadWebEvidenceDevDataset();
  const coverage = summarizeWebEvidenceDevCoverage(dataset);

  test("is a versioned development split and never an official holdout", () => {
    expect(dataset.protocol_id).toBe("web-evidence-dev-eval");
    expect(dataset.protocol_version).toBe("0.1.0");
    expect(dataset.dataset_version).toBe("0.1.0");
    expect(dataset.role).toBe("development_only");
    expect(dataset.split).toBe("dev");
    expect(dataset.official_holdout).toBe(false);
    expect(dataset.may_claim_official_locked_generalization).toBe(false);
    expect(dataset.query_budget).toEqual({
      max_queries_per_article: 2,
      max_queries_per_claim: 1,
      max_results_per_query: 3,
    });
    expect(dataset.provenance).toEqual({
      authoring: "handwritten_synthetic",
      contains_unpublished_real_articles: false,
      contains_real_pii: false,
      contains_holdout_gold: false,
      network_required_to_score: false,
    });
  });

  test("covers six high-risk categories, four statuses, and both trigger decisions", () => {
    expect(coverage.risk_categories).toEqual([...RISK_CATEGORIES]);
    expect(coverage.expected_statuses).toEqual([...EXPECTED_STATUSES]);
    expect(coverage.trigger_true).toBeGreaterThanOrEqual(12);
    expect(coverage.trigger_false).toBe(6);
    expect(coverage.expected_failures).toBe(2);
    expect(coverage.case_count).toBe(25);
    for (const category of RISK_CATEGORIES) {
      const rows = dataset.cases.filter((item) => item.risk_category === category);
      expect(rows.some((item) => item.should_trigger_query)).toBe(true);
      expect(rows.some((item) => !item.should_trigger_query)).toBe(true);
    }
  });

  test("every case has the required adjudication fields", () => {
    for (const item of dataset.cases) {
      expect(item.claim.text.length).toBeGreaterThan(0);
      expect(item.article_excerpt.includes(item.claim.span_quote)).toBe(true);
      expect(item.forbidden_outbound_fields.length).toBeGreaterThan(0);
      expect(item.adjudication_hint.length).toBeGreaterThan(0);
      if (item.should_trigger_query) {
        expect(item.allowed_source_classes.length).toBeGreaterThan(0);
        expect(item.expected_status).not.toBe("not_applicable");
        expect(
          item.allowed_source_classes.every((value) =>
            (ALLOWED_SOURCE_CLASSES as readonly string[]).includes(value),
          ),
        ).toBe(true);
      } else {
        expect(item.expected_status).toBe("not_applicable");
        expect(item.allowed_source_classes).toEqual([]);
      }
    }
  });

  test("does not reuse in-repo review benchmark or holdout article ids", () => {
    const reviewDataset = loadBenchmarkDataset();
    const reviewArticleIds = new Set(reviewDataset.articles.map((item) => item.article_id));
    for (const item of dataset.cases) {
      expect(item.article_id.startsWith("we-dev-art-")).toBe(true);
      expect(item.case_id.startsWith("we-dev-")).toBe(true);
      expect(reviewArticleIds.has(item.article_id)).toBe(false);
      expect(item.article_id.startsWith("lock-")).toBe(false);
      expect(item.case_id.includes("holdout")).toBe(false);
    }
  });

  test("synthetic fixtures do not embed real contact PII or holdout identifiers", () => {
    const raw = readFileSync(webEvidenceDevDatasetPath(), "utf8");
    expect(raw).not.toMatch(/\b1[3-9]\d{9}\b/);
    expect(raw).not.toMatch(/\b\d{17}[\dXx]\b/);
    expect(raw).not.toMatch(/"holdout_id"\s*:/);
    expect(raw).not.toContain("HOLDOUT_CUSTODIAN");
    for (const item of dataset.cases) {
      expect(item.article_excerpt).not.toMatch(/@gmail\.com|@qq\.com|@163\.com/i);
      expect(item.article_excerpt).not.toContain("holdout");
      expect(item.claim.text).not.toContain("holdout");
      for (const value of Object.values(item.sensitive_context)) {
        expect(value.startsWith("SEND-FORBIDDEN") || value.includes("example.invalid")).toBe(true);
      }
    }
  });

  test("does not load the unfinished web-evidence package or product runtime", () => {
    const sourceRoot = join(process.cwd(), "packages/benchmark/src/web-evidence-eval");
    const files = ["index.ts", "schema.ts", "evaluate.ts"];
    for (const name of files) {
      const text = readFileSync(join(sourceRoot, name), "utf8");
      expect(text).not.toContain("@grc/web-evidence");
      expect(text).not.toContain("@grc/review-core");
      expect(text).not.toContain("@grc/providers");
      expect(text).not.toContain("@grc/contracts");
      expect(text).not.toContain("fetch(");
    }
  });

  test("unevaluated scorecard is not_run and does not invent a pass", () => {
    const scorecard = unevaluatedWebEvidenceDevScorecard(dataset);
    expect(scorecard.run_status).toBe("not_run");
    expect(scorecard.all_gates_passed).toBeNull();
    expect(scorecard.metrics).toBeNull();
    expect(scorecard.official_holdout).toBe(false);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
    expect(scorecard.disclaimer).toContain("不能作为 official locked");
  });

  test("protocol self-check traces exercise the scorer without claiming a product pass", () => {
    const scorecard = scoreWebEvidenceDevRun(dataset, goldAlignedTraces(dataset), {
      result_class: "protocol_self_check",
    });
    expect(scorecard.result_class).toBe("protocol_self_check");
    expect(scorecard.run_status).toBe("scored");
    expect(scorecard.coverage_complete).toBe(true);
    expect(scorecard.metrics).not.toBeNull();
    expect(scorecard.tally?.trigger_fn).toBe(2);
    expect(scorecard.tally?.trigger_fp).toBe(0);
    expect(scorecard.metrics?.query_trigger_accuracy).toBe(23 / 25);
    expect(scorecard.metrics?.query_budget_compliance_rate).toBe(1);
    expect(scorecard.metrics?.privacy_minimization_compliance_rate).toBe(1);
    expect(scorecard.metrics?.failure_degradation_correctness).toBe(1);
    expect(scorecard.all_gates_passed).toBe(true);
    expect(scorecard.may_claim_official_locked_generalization).toBe(false);
    expect(scorecard.disclaimer).toContain("not_run 不得写成通过");
  });

  test("incomplete traces fail closed instead of reporting a pass", () => {
    const traces = goldAlignedTraces(dataset).slice(0, 3);
    const scorecard = scoreWebEvidenceDevRun(dataset, traces, { result_class: "protocol_self_check" });
    expect(scorecard.coverage_complete).toBe(false);
    expect(scorecard.all_gates_passed).toBe(false);
    expect(scorecard.diagnostics.missing_case_ids.length).toBeGreaterThan(0);
  });

  test("detects trigger, budget, authority, traceability, degradation, and privacy violations", () => {
    const traces = goldAlignedTraces(dataset);
    const byId = new Map(traces.map((item) => [item.case_id, item]));

    const skip = byId.get("we-dev-003-person-title-skip");
    const timeout = byId.get("we-dev-020-degrade-timeout");
    const number = byId.get("we-dev-013-number-conflict");
    const privacy = byId.get("we-dev-019-privacy-min");
    const budgetSkipped = traces.find((item) => {
      const gold = dataset.cases.find((row) => row.case_id === item.case_id);
      return gold?.article_id === BUDGET_ARTICLE_ID && gold.should_trigger_query && !item.triggered;
    });
    if (!skip || !timeout || !number || !privacy || !budgetSkipped) {
      throw new Error("required protocol self-check traces are missing");
    }

    skip.triggered = true;
    skip.query_count = 1;
    skip.query_text = "张叔";
    skip.status = "confirmed";

    timeout.status = "confirmed";
    timeout.failure = { kind: "timeout" };

    number.sources = [{ source_class: "personal_blog", locator: "", excerpt: "" }];

    privacy.outbound_fields = ["claim_text", "reporter_phone"];
    privacy.outbound_text_blobs = ["SEND-FORBIDDEN-PHONE"];

    budgetSkipped.triggered = true;
    budgetSkipped.query_count = 1;
    budgetSkipped.query_text = budgetSkipped.query_text ?? "budget overflow";
    budgetSkipped.status = "insufficient";

    const scorecard = scoreWebEvidenceDevRun(dataset, traces, { result_class: "protocol_self_check" });
    expect(scorecard.tally?.trigger_fp).toBe(1);
    expect(scorecard.metrics?.query_budget_compliance_rate).toBeLessThan(1);
    expect(scorecard.metrics?.authoritative_source_ratio).toBeLessThan(1);
    expect(scorecard.metrics?.evidence_traceability_rate).toBeLessThan(1);
    expect(scorecard.metrics?.failure_degradation_correctness).toBeLessThan(1);
    expect(scorecard.metrics?.privacy_minimization_compliance_rate).toBeLessThan(1);
    expect(scorecard.all_gates_passed).toBe(false);
    const failed = new Set(
      (scorecard.gates ?? []).filter((gate) => !gate.passed).map((gate) => gate.metric),
    );
    expect(failed.has("query_budget_compliance_rate")).toBe(true);
    expect(failed.has("failure_degradation_correctness")).toBe(true);
    expect(failed.has("privacy_minimization_compliance_rate")).toBe(true);
  });

  test("defined gates match the documented development thresholds", () => {
    expect(dataset.gates).toEqual({
      query_trigger_accuracy: { operator: "gte", threshold: 0.85, hardness: "soft" },
      query_budget_compliance_rate: { operator: "eq", threshold: 1, hardness: "hard" },
      authoritative_source_ratio: { operator: "gte", threshold: 0.8, hardness: "soft" },
      evidence_traceability_rate: { operator: "gte", threshold: 0.9, hardness: "soft" },
      failure_degradation_correctness: { operator: "eq", threshold: 1, hardness: "hard" },
      privacy_minimization_compliance_rate: { operator: "eq", threshold: 1, hardness: "hard" },
    });
  });
});
