import type { CanonicalArticle, Finding, FindingType, Severity } from "@/lib/contracts/review";
import { fieldText, findAllExact } from "@/lib/server/span-locator";

export type GoldIssue = {
  issue_id: string;
  type: FindingType;
  severity: Severity;
  field: "title" | "body";
  quoted_text: string;
  occurrence: number;
  requires_evidence: boolean;
};

export type BenchmarkArticle = {
  article_id: string;
  split: "dev" | "locked";
  title: string;
  body: string;
  issues: GoldIssue[];
};

export type LocatedGoldIssue = GoldIssue & {
  start_offset: number;
  end_offset: number;
};

export type BenchmarkMetrics = {
  overall_recall: number;
  critical_high_recall: number;
  precision: number;
  fp_per_article: number;
  evidence_coverage: number;
  exact_span_rate: number;
  mean_overlap: number;
  top5_recall: number;
  ndcg_at_10: number;
  span_validation: number;
  latency_ms: number | null;
  cost_usd: number | null;
};

function locateGold(article: CanonicalArticle, issue: GoldIssue): LocatedGoldIssue | null {
  const text = fieldText(article, issue.field);
  const matches = findAllExact(text, issue.quoted_text);
  const match = matches[issue.occurrence];
  if (!match) {
    return null;
  }
  return {
    ...issue,
    start_offset: match.start,
    end_offset: match.end,
  };
}

function overlap(a: { start_offset: number; end_offset: number }, b: {
  start_offset: number;
  end_offset: number;
}): number {
  const start = Math.max(a.start_offset, b.start_offset);
  const end = Math.min(a.end_offset, b.end_offset);
  if (end <= start) {
    return 0;
  }
  const union = Math.max(a.end_offset, b.end_offset) - Math.min(a.start_offset, b.start_offset);
  return union === 0 ? 0 : (end - start) / union;
}

function isHigh(severity: Severity): boolean {
  return severity === "critical" || severity === "high";
}

function hasReliableEvidence(finding: Finding): boolean {
  return finding.evidence.some(
    (item) =>
      item.kind === "rule" ||
      (item.kind === "retrieved_source" && Boolean(item.source_id) && Boolean(item.source_url)),
  );
}

function dcg(rels: number[]): number {
  return rels.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
}

export function evaluateReview(article: CanonicalArticle, findings: Finding[], gold: GoldIssue[]): {
  metrics: Omit<BenchmarkMetrics, "latency_ms" | "cost_usd">;
  unmatchedGold: string[];
  goldLocateFailures: string[];
} {
  const located: LocatedGoldIssue[] = [];
  const goldLocateFailures: string[] = [];
  for (const issue of gold) {
    const found = locateGold(article, issue);
    if (!found) {
      goldLocateFailures.push(issue.issue_id);
    } else {
      located.push(found);
    }
  }

  const usedFindings = new Set<string>();
  const matches: Array<{ gold: LocatedGoldIssue; finding: Finding; iou: number; exact: boolean }> = [];

  for (const issue of located) {
    let best: { finding: Finding; iou: number; exact: boolean } | null = null;
    for (const finding of findings) {
      if (usedFindings.has(finding.finding_id) || finding.source_span.field !== issue.field) {
        continue;
      }
      const exact =
        finding.source_span.start_offset === issue.start_offset &&
        finding.source_span.end_offset === issue.end_offset;
      const quoteMatch = finding.source_span.quoted_text === issue.quoted_text;
      const iou = overlap(finding.source_span, issue);
      if (!exact && !quoteMatch && iou < 0.5) {
        continue;
      }
      const score = exact ? 2 : quoteMatch ? 1.5 : iou;
      const bestScore = best ? (best.exact ? 2 : best.finding.source_span.quoted_text === issue.quoted_text ? 1.5 : best.iou) : -1;
      if (score > bestScore) {
        best = { finding, iou: exact ? 1 : iou, exact };
      }
    }
    if (best) {
      usedFindings.add(best.finding.finding_id);
      matches.push({ gold: issue, finding: best.finding, iou: best.iou, exact: best.exact });
    }
  }

  const unmatchedGold = located.filter((issue) => !matches.some((item) => item.gold.issue_id === issue.issue_id)).map((item) => item.issue_id);
  const highGold = located.filter((item) => isHigh(item.severity));
  const highMatches = matches.filter((item) => isHigh(item.gold.severity));
  const tp = matches.length;
  const fp = Math.max(0, findings.length - tp);
  const highFindings = findings.filter((item) => isHigh(item.severity));
  const exactMatches = matches.filter((item) => item.exact).length;
  const meanOverlap = matches.length === 0 ? 0 : matches.reduce((sum, item) => sum + item.iou, 0) / matches.length;
  const validated = findings.filter((finding) => {
    const text = fieldText(article, finding.source_span.field);
    return text.slice(finding.source_span.start_offset, finding.source_span.end_offset) === finding.source_span.quoted_text;
  }).length;

  const top5 = findings.slice(0, 5);
  const top5Matched = highGold.filter((issue) =>
    top5.some((finding) => {
      if (finding.source_span.field !== issue.field) {
        return false;
      }
      return (
        finding.source_span.quoted_text === issue.quoted_text ||
        overlap(finding.source_span, issue) >= 0.5
      );
    }),
  ).length;

  const rels = findings.slice(0, 10).map((finding) =>
    located.some(
      (issue) =>
        isHigh(issue.severity) &&
        issue.field === finding.source_span.field &&
        (finding.source_span.quoted_text === issue.quoted_text || overlap(finding.source_span, issue) >= 0.5),
    )
      ? 1
      : 0,
  );
  const ideal = [...rels].sort((a, b) => b - a);
  const ndcg = dcg(ideal) === 0 ? 0 : dcg(rels) / dcg(ideal);

  return {
    unmatchedGold,
    goldLocateFailures,
    metrics: {
      overall_recall: located.length === 0 ? 0 : tp / located.length,
      critical_high_recall: highGold.length === 0 ? 0 : highMatches.length / highGold.length,
      precision: findings.length === 0 ? 0 : tp / findings.length,
      fp_per_article: fp,
      evidence_coverage:
        highFindings.length === 0 ? 1 : highFindings.filter(hasReliableEvidence).length / highFindings.length,
      exact_span_rate: matches.length === 0 ? 0 : exactMatches / matches.length,
      mean_overlap: meanOverlap,
      top5_recall: highGold.length === 0 ? 0 : top5Matched / highGold.length,
      ndcg_at_10: ndcg,
      span_validation: findings.length === 0 ? 1 : validated / findings.length,
    },
  };
}

export function averageMetrics(
  rows: BenchmarkMetrics[],
): BenchmarkMetrics {
  const n = rows.length || 1;
  const sum = rows.reduce(
    (acc, row) => ({
      overall_recall: acc.overall_recall + row.overall_recall,
      critical_high_recall: acc.critical_high_recall + row.critical_high_recall,
      precision: acc.precision + row.precision,
      fp_per_article: acc.fp_per_article + row.fp_per_article,
      evidence_coverage: acc.evidence_coverage + row.evidence_coverage,
      exact_span_rate: acc.exact_span_rate + row.exact_span_rate,
      mean_overlap: acc.mean_overlap + row.mean_overlap,
      top5_recall: acc.top5_recall + row.top5_recall,
      ndcg_at_10: acc.ndcg_at_10 + row.ndcg_at_10,
      span_validation: acc.span_validation + row.span_validation,
      latency_ms: (acc.latency_ms ?? 0) + (row.latency_ms ?? 0),
      cost_usd: (acc.cost_usd ?? 0) + (row.cost_usd ?? 0),
    }),
    {
      overall_recall: 0,
      critical_high_recall: 0,
      precision: 0,
      fp_per_article: 0,
      evidence_coverage: 0,
      exact_span_rate: 0,
      mean_overlap: 0,
      top5_recall: 0,
      ndcg_at_10: 0,
      span_validation: 0,
      latency_ms: 0,
      cost_usd: 0,
    } satisfies BenchmarkMetrics,
  );
  const hasCost = rows.some((row) => row.cost_usd != null);
  const hasLatency = rows.some((row) => row.latency_ms != null);
  return {
    overall_recall: sum.overall_recall / n,
    critical_high_recall: sum.critical_high_recall / n,
    precision: sum.precision / n,
    fp_per_article: sum.fp_per_article / n,
    evidence_coverage: sum.evidence_coverage / n,
    exact_span_rate: sum.exact_span_rate / n,
    mean_overlap: sum.mean_overlap / n,
    top5_recall: sum.top5_recall / n,
    ndcg_at_10: sum.ndcg_at_10 / n,
    span_validation: sum.span_validation / n,
    latency_ms: hasLatency ? (sum.latency_ms ?? 0) / n : null,
    cost_usd: hasCost ? (sum.cost_usd ?? 0) / n : null,
  };
}
