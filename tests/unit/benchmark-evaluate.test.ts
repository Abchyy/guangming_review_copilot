import { describe, expect, test } from "vitest";

import type { CanonicalArticle, EvidenceItem, Finding, FindingType, Severity } from "@grc/contracts";
import {
  averageMetrics,
  evaluateReview,
  GoldLocateFailureError,
  type GoldIssue,
} from "@grc/benchmark";
import { fieldText, findAllExact } from "@grc/review-core";

const article: CanonicalArticle = {
  title: "标题里也有问题A",
  body: "正文先写问题A。随后给出重叠片段AAA BBB CCC。最后再次出现问题A。另有数字128万人。",
  version: 1,
};

function spanAt(
  field: "title" | "body",
  quotedText: string,
  occurrence = 0,
): Finding["source_span"] {
  const text = fieldText(article, field);
  const match = findAllExact(text, quotedText)[occurrence];
  if (!match) {
    throw new Error(`test fixture quote not found: ${field} ${quotedText} #${occurrence}`);
  }
  return {
    field,
    start_offset: match.start,
    end_offset: match.end,
    quoted_text: quotedText,
    paragraph_index: 0,
    article_version: 1,
  };
}

function goldIssue(partial: Partial<GoldIssue> & Pick<GoldIssue, "issue_id" | "quoted_text">): GoldIssue {
  return {
    type: "basic_text",
    severity: "low",
    field: "body",
    occurrence: 0,
    requires_evidence: false,
    ...partial,
  };
}

function finding(partial: Partial<Finding> & Pick<Finding, "finding_id" | "source_span">): Finding {
  return {
    type: "basic_text",
    severity: "low",
    title: "问题",
    reason: "测试用预测",
    suggestion: { text: "修改", replacement: null },
    confidence: 0.9,
    evidence: [{ kind: "ai_judgment", excerpt: "无依据", citation_validated: false }],
    status: "pending",
    ...partial,
  };
}

function withEvidence(items: EvidenceItem[]): Pick<Finding, "evidence"> {
  return { evidence: items };
}

function dcg(rels: number[]): number {
  return rels.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
}

describe("benchmark evaluator matching", () => {
  test("wrong type at the same span is not a TP", () => {
    const gold = [goldIssue({ issue_id: "g-number", type: "number", quoted_text: "128万人", severity: "high" })];
    const predictions = [
      finding({
        finding_id: "f-wrong-type",
        type: "basic_text",
        source_span: spanAt("body", "128万人"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches).toEqual([]);
    expect(result.metrics.tally.tp).toBe(0);
    expect(result.metrics.tally.fp).toBe(1);
    expect(result.metrics.tally.fn).toBe(1);
    expect(result.metrics.overall_recall).toBe(0);
    expect(result.metrics.precision).toBe(0);
  });

  test("wrong occurrence is not a TP even when quoted_text matches", () => {
    const gold = [goldIssue({ issue_id: "g-second", quoted_text: "问题A", occurrence: 1 })];
    const predictions = [
      finding({
        finding_id: "f-first",
        source_span: spanAt("body", "问题A", 0),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches).toEqual([]);
    expect(result.metrics.tally.tp).toBe(0);
    expect(result.metrics.tally.fn).toBe(1);
  });

  test("wrong location / field is not a TP", () => {
    const gold = [goldIssue({ issue_id: "g-body", quoted_text: "问题A", field: "body", occurrence: 0 })];
    const predictions = [
      finding({
        finding_id: "f-title",
        source_span: spanAt("title", "问题A"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches).toEqual([]);
    expect(result.metrics.tally.tp).toBe(0);
  });

  test("invalid source span is not a TP", () => {
    const gold = [goldIssue({ issue_id: "g-typo", quoted_text: "问题A", occurrence: 0 })];
    const valid = spanAt("body", "问题A", 0);
    const predictions = [
      finding({
        finding_id: "f-invalid",
        source_span: {
          ...valid,
          quoted_text: "不是原文",
        },
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches).toEqual([]);
    expect(result.metrics.tally.tp).toBe(0);
    expect(result.metrics.tally.fp).toBe(1);
    expect(result.metrics.span_validation).toBe(0);
  });

  test("repeated text matches the labeled occurrence only", () => {
    const gold = [
      goldIssue({ issue_id: "g-first", quoted_text: "问题A", occurrence: 0 }),
      goldIssue({ issue_id: "g-second", quoted_text: "问题A", occurrence: 1 }),
    ];
    const predictions = [
      finding({
        finding_id: "f-second",
        source_span: spanAt("body", "问题A", 1),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches.map((item) => item.gold_id)).toEqual(["g-second"]);
    expect(result.unmatchedGold).toEqual(["g-first"]);
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.metrics.tally.fn).toBe(1);
  });

  test("one prediction can match at most one gold", () => {
    const gold = [
      goldIssue({ issue_id: "g-left", quoted_text: "AAA BBB" }),
      goldIssue({ issue_id: "g-right", quoted_text: "BBB CCC" }),
    ];
    const predictions = [
      finding({
        finding_id: "f-wide",
        source_span: spanAt("body", "AAA BBB CCC"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.matches).toHaveLength(1);
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.metrics.tally.fp).toBe(0);
    expect(result.metrics.tally.fn).toBe(1);
  });

  test("gold input order does not change metrics or match pairs", () => {
    const gold = [
      goldIssue({ issue_id: "g-z", quoted_text: "AAA BBB", requires_evidence: true }),
      goldIssue({ issue_id: "g-a", quoted_text: "BBB CCC", requires_evidence: false }),
    ];
    const predictions = [
      finding({
        finding_id: "f-wide",
        source_span: spanAt("body", "AAA BBB CCC"),
        ...withEvidence([
          {
            kind: "rule",
            excerpt: "AAA BBB",
            citation_validated: true,
            rule_id: "rule.test",
            article_spans: [spanAt("body", "AAA BBB CCC")],
          },
        ]),
      }),
    ];
    const forward = evaluateReview(article, predictions, gold);
    const reversed = evaluateReview(article, predictions, [...gold].reverse());
    expect(reversed.metrics).toEqual(forward.metrics);
    expect(reversed.matches).toEqual(forward.matches);
  });

  test("gold locate failure fails the evaluation", () => {
    const gold = [goldIssue({ issue_id: "g-missing", quoted_text: "这段文字并不存在" })];
    expect(() => evaluateReview(article, [], gold)).toThrow(GoldLocateFailureError);
    try {
      evaluateReview(article, [], gold);
      throw new Error("expected locate failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GoldLocateFailureError);
      expect((error as GoldLocateFailureError).issueIds).toEqual(["g-missing"]);
    }
  });
});

describe("benchmark evaluator aggregation", () => {
  test("dataset precision/recall use micro TP/FP/FN", () => {
    const goldA = [
      goldIssue({ issue_id: "a1", quoted_text: "问题A", occurrence: 0 }),
      goldIssue({ issue_id: "a2", quoted_text: "128万人", type: "number" }),
    ];
    const predA = [
      finding({ finding_id: "fa1", source_span: spanAt("body", "问题A", 0) }),
      finding({ finding_id: "fa2", type: "number", source_span: spanAt("body", "128万人") }),
    ];
    const goldB = [goldIssue({ issue_id: "b1", quoted_text: "问题A", occurrence: 1 })];
    const predB = [
      finding({ finding_id: "fb1", source_span: spanAt("body", "数字128万人") }),
      finding({ finding_id: "fb2", source_span: spanAt("title", "问题A") }),
    ];

    const articleA = evaluateReview(article, predA, goldA);
    const articleB = evaluateReview(article, predB, goldB);
    const aggregated = averageMetrics([
      { ...articleA.metrics, latency_ms: null, cost_usd: null },
      { ...articleB.metrics, latency_ms: null, cost_usd: null },
    ]);

    expect(articleA.metrics.overall_recall).toBe(1);
    expect(articleB.metrics.overall_recall).toBe(0);
    expect(aggregated.tally.tp).toBe(2);
    expect(aggregated.tally.fp).toBe(2);
    expect(aggregated.tally.fn).toBe(1);
    expect(aggregated.overall_recall).toBeCloseTo(2 / 3, 10);
    expect(aggregated.precision).toBeCloseTo(2 / 4, 10);
    expect(aggregated.fp_per_article).toBe(1);
  });

  test("articles without Critical/High gold are not mixed in as zero", () => {
    const highGold = [
      goldIssue({
        issue_id: "high-1",
        quoted_text: "128万人",
        type: "number",
        severity: "high",
      }),
    ];
    const lowGold = [goldIssue({ issue_id: "low-1", quoted_text: "问题A", occurrence: 0, severity: "low" })];
    const highHit = evaluateReview(
      article,
      [
        finding({
          finding_id: "f-high",
          type: "number",
          severity: "high",
          source_span: spanAt("body", "128万人"),
        }),
      ],
      highGold,
    );
    const lowOnlyMiss = evaluateReview(article, [], lowGold);
    const aggregated = averageMetrics([
      { ...highHit.metrics, latency_ms: null, cost_usd: null },
      { ...lowOnlyMiss.metrics, latency_ms: null, cost_usd: null },
    ]);

    expect(highHit.metrics.critical_high_recall).toBe(1);
    expect(lowOnlyMiss.metrics.critical_high_recall).toBe(0);
    expect(lowOnlyMiss.metrics.tally.critical_high_gold).toBe(0);
    expect(aggregated.critical_high_recall).toBe(1);
    expect(aggregated.tally.critical_high_gold).toBe(1);
  });
});

describe("benchmark evaluator ranking and evidence", () => {
  test("Top-5 duplicate predictions do not score twice", () => {
    const gold = [
      goldIssue({
        issue_id: "g-high",
        quoted_text: "128万人",
        type: "number",
        severity: "high",
      }),
    ];
    const duplicateSpan = spanAt("body", "128万人");
    const predictions = Array.from({ length: 6 }, (_, index) =>
      finding({
        finding_id: `dup-${index}`,
        type: "number",
        severity: "high",
        source_span: duplicateSpan,
      }),
    );
    const result = evaluateReview(article, predictions, gold);
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.metrics.tally.fp).toBe(5);
    expect(result.metrics.tally.top5_tp).toBe(1);
    expect(result.metrics.top5_recall).toBe(1);
    expect(result.metrics.precision).toBeCloseTo(1 / 6, 10);
  });

  test("NDCG penalizes missed relevant gold using the full IDCG", () => {
    const gold = [
      goldIssue({
        issue_id: "g-hit",
        quoted_text: "128万人",
        type: "number",
        severity: "high",
      }),
      goldIssue({
        issue_id: "g-miss",
        quoted_text: "问题A",
        occurrence: 1,
        severity: "high",
      }),
    ];
    const predictions = [
      finding({
        finding_id: "f-hit",
        type: "number",
        severity: "high",
        source_span: spanAt("body", "128万人"),
      }),
      finding({
        finding_id: "f-fp",
        source_span: spanAt("title", "问题A"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    const expected = dcg([1, 0]) / dcg([1, 1]);
    expect(result.metrics.ndcg_at_10).toBeCloseTo(expected, 10);
    expect(result.metrics.ndcg_at_10).toBeLessThan(1);
    expect(result.metrics.tally.fn).toBe(1);
  });

  test("Evidence coverage uses matched requires_evidence gold only", () => {
    const gold = [
      goldIssue({
        issue_id: "need-ev",
        quoted_text: "128万人",
        type: "number",
        severity: "high",
        requires_evidence: true,
      }),
      goldIssue({
        issue_id: "no-ev",
        quoted_text: "问题A",
        occurrence: 0,
        requires_evidence: false,
      }),
    ];
    const covered = evaluateReview(
      article,
      [
        finding({
          finding_id: "f-covered",
          type: "number",
          severity: "high",
          source_span: spanAt("body", "128万人"),
          ...withEvidence([
            {
              kind: "rule",
              excerpt: "128万人",
              citation_validated: true,
              rule_id: "rule.metric",
              article_spans: [spanAt("body", "128万人")],
            },
          ]),
        }),
        finding({
          finding_id: "f-no-ev-need",
          source_span: spanAt("body", "问题A", 0),
        }),
      ],
      gold,
    );
    expect(covered.metrics.tally.evidence_required).toBe(1);
    expect(covered.metrics.tally.evidence_covered).toBe(1);
    expect(covered.metrics.evidence_coverage).toBe(1);

    const invalidEvidence = evaluateReview(
      article,
      [
        finding({
          finding_id: "f-invalid-ev",
          type: "number",
          severity: "high",
          source_span: spanAt("body", "128万人"),
          ...withEvidence([
            {
              kind: "rule",
              excerpt: "128万人",
              citation_validated: true,
              article_spans: [spanAt("body", "128万人")],
            },
            {
              kind: "retrieved_source",
              excerpt: "128万人",
              citation_validated: true,
              source_id: "src.unknown",
              article_spans: [spanAt("body", "问题A", 1)],
            },
            {
              kind: "ai_judgment",
              excerpt: "看起来不对",
              citation_validated: false,
            },
          ]),
        }),
      ],
      [gold[0]],
    );
    expect(invalidEvidence.metrics.tally.tp).toBe(1);
    expect(invalidEvidence.metrics.tally.evidence_required).toBe(1);
    expect(invalidEvidence.metrics.tally.evidence_covered).toBe(0);
    expect(invalidEvidence.metrics.evidence_coverage).toBe(0);

    const unmatchedHighWithEvidence = evaluateReview(
      article,
      [
        finding({
          finding_id: "f-unmatched-high",
          type: "person" as FindingType,
          severity: "critical" as Severity,
          source_span: spanAt("title", "问题A"),
          ...withEvidence([
            {
              kind: "retrieved_source",
              excerpt: "问题A",
              citation_validated: true,
              source_id: "src.edu",
              source_url: "https://example.invalid/source",
              article_spans: [spanAt("title", "问题A")],
            },
          ]),
        }),
      ],
      [gold[0]],
    );
    expect(unmatchedHighWithEvidence.metrics.tally.tp).toBe(0);
    expect(unmatchedHighWithEvidence.metrics.tally.evidence_required).toBe(0);
    expect(unmatchedHighWithEvidence.metrics.evidence_coverage).toBe(1);
  });
});

describe("benchmark evaluator P1 regressions", () => {
  test("same-cardinality conflict prefers exact High gold over partial Low gold", () => {
    const gold = [
      goldIssue({ issue_id: "a-low", quoted_text: "AAA BBB", severity: "low" }),
      goldIssue({ issue_id: "z-high", quoted_text: "AAA BBB CCC", severity: "high" }),
    ];
    const predictions = [
      finding({
        finding_id: "f-wide",
        severity: "high",
        source_span: spanAt("body", "AAA BBB CCC"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.matches.map((item) => item.gold_id)).toEqual(["z-high"]);
    expect(result.metrics.critical_high_recall).toBe(1);
    expect(result.metrics.top5_recall).toBe(1);
    expect(result.metrics.mean_overlap).toBe(1);
    expect(result.matches[0]?.exact).toBe(true);

    const swappedIds = evaluateReview(
      article,
      predictions,
      [
        goldIssue({ issue_id: "z-low", quoted_text: "AAA BBB", severity: "low" }),
        goldIssue({ issue_id: "a-high", quoted_text: "AAA BBB CCC", severity: "high" }),
      ],
    );
    expect(swappedIds.matches.map((item) => item.gold_id)).toEqual(["a-high"]);
    expect(swappedIds.metrics.critical_high_recall).toBe(1);
    expect(swappedIds.metrics.mean_overlap).toBe(1);
  });

  test("NDCG keeps gain on an earlier legal hit when a later duplicate is more exact", () => {
    const gold = [
      goldIssue({
        issue_id: "g-high",
        quoted_text: "AAA BBB CCC",
        severity: "high",
      }),
    ];
    const predictions = [
      finding({
        finding_id: "z-early-partial",
        severity: "high",
        source_span: spanAt("body", "AAA BBB"),
      }),
      finding({
        finding_id: "a-later-exact",
        severity: "high",
        source_span: spanAt("body", "AAA BBB CCC"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.metrics.ndcg_at_10).toBeCloseTo(dcg([1, 0]) / dcg([1]), 10);
    expect(result.metrics.ndcg_at_10).toBe(1);
  });

  test("NDCG re-pairs golds so a later unique hit keeps its relevance", () => {
    const gold = [
      goldIssue({
        issue_id: "g-a-contested",
        quoted_text: "AAA BBB CCC",
        severity: "high",
      }),
      goldIssue({
        issue_id: "g-b-alt",
        quoted_text: "AAA BBB",
        severity: "high",
      }),
    ];
    const predictions = [
      finding({
        finding_id: "f-rank1-both",
        severity: "high",
        source_span: spanAt("body", "AAA BBB CCC"),
      }),
      finding({
        finding_id: "f-rank2-only-a",
        severity: "high",
        source_span: spanAt("body", "BBB CCC"),
      }),
    ];
    const result = evaluateReview(article, predictions, gold);
    expect(result.metrics.ndcg_at_10).toBe(1);
    expect(result.metrics.ndcg_at_10).toBeCloseTo(dcg([1, 1]) / dcg([1, 1]), 10);
    expect(result.metrics.tally.critical_high_gold).toBe(2);
  });

  test("NDCG prefers earlier remaining hits over gold-ID tie-breaks", () => {
    const predictions = [
      finding({
        finding_id: "f-rank1-both",
        severity: "high",
        source_span: spanAt("body", "AAA BBB CCC"),
      }),
      finding({
        finding_id: "f-rank2-only-a",
        severity: "high",
        source_span: spanAt("body", "AAA BBB"),
      }),
      finding({
        finding_id: "f-rank3-only-b",
        severity: "high",
        source_span: spanAt("body", "BBB CCC"),
      }),
    ];
    const goldAB = [
      goldIssue({ issue_id: "a-gold", quoted_text: "AAA BBB", severity: "high" }),
      goldIssue({ issue_id: "b-gold", quoted_text: "BBB CCC", severity: "high" }),
    ];
    const goldSwapped = [
      goldIssue({ issue_id: "z-gold", quoted_text: "AAA BBB", severity: "high" }),
      goldIssue({ issue_id: "a-gold", quoted_text: "BBB CCC", severity: "high" }),
    ];
    const result = evaluateReview(article, predictions, goldAB);
    const swapped = evaluateReview(article, predictions, goldSwapped);
    const expected = dcg([1, 1, 0]) / dcg([1, 1]);
    expect(result.metrics.ndcg_at_10).toBeCloseTo(expected, 10);
    expect(result.metrics.ndcg_at_10).toBe(1);
    expect(swapped.metrics.ndcg_at_10).toBe(1);
    expect(swapped.metrics).toEqual(result.metrics);
    expect(result.metrics.ndcg_at_10).toBeGreaterThan(dcg([1, 0, 1]) / dcg([1, 1]));
  });

  test("reliable Evidence still covers a matched gold without spatial overlap", () => {
    const gold = [
      goldIssue({
        issue_id: "need-ev",
        quoted_text: "128万人",
        type: "number",
        severity: "high",
        requires_evidence: true,
      }),
    ];
    const result = evaluateReview(
      article,
      [
        finding({
          finding_id: "f-covered",
          type: "number",
          severity: "high",
          source_span: spanAt("body", "128万人"),
          ...withEvidence([
            {
              kind: "rule",
              excerpt: "规则摘录不必落在 gold span 上",
              citation_validated: true,
              rule_id: "rule.metric",
              article_spans: [spanAt("title", "问题A")],
            },
          ]),
        }),
      ],
      gold,
    );
    expect(result.metrics.tally.tp).toBe(1);
    expect(result.metrics.tally.evidence_required).toBe(1);
    expect(result.metrics.tally.evidence_covered).toBe(1);
    expect(result.metrics.evidence_coverage).toBe(1);
  });
});
