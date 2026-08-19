import type {
  CanonicalArticle,
  EvidenceItem,
  Finding,
  FindingType,
  Severity,
  SourceSpan,
} from "@/lib/contracts/review";
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

export type BenchmarkSplit = "dev" | "regression";

export type BenchmarkArticle = {
  article_id: string;
  split: BenchmarkSplit;
  title: string;
  body: string;
  issues: GoldIssue[];
};

export type LocatedGoldIssue = GoldIssue & {
  start_offset: number;
  end_offset: number;
};

export type BenchmarkTally = {
  tp: number;
  fp: number;
  fn: number;
  critical_high_tp: number;
  critical_high_gold: number;
  evidence_covered: number;
  evidence_required: number;
  top5_tp: number;
  exact_matches: number;
  match_count: number;
  overlap_sum: number;
  validated_spans: number;
  prediction_count: number;
  ndcg_included: number;
  ndcg_value: number;
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
  tally: BenchmarkTally;
};

export type BenchmarkMatch = {
  gold_id: string;
  finding_id: string;
  exact: boolean;
  iou: number;
};

export class GoldLocateFailureError extends Error {
  readonly issueIds: string[];

  constructor(issueIds: string[]) {
    super(`Gold issues could not be located in source: ${issueIds.join(", ")}`);
    this.name = "GoldLocateFailureError";
    this.issueIds = issueIds;
  }
}

const IOU_THRESHOLD = 0.5;
const TOP_K = 5;
const NDCG_K = 10;

type MatchEdge = {
  goldIndex: number;
  findingIndex: number;
  exact: boolean;
  iou: number;
  score: number;
  high: boolean;
  evidenceCovered: boolean;
};

type MatchQuality = {
  cardinality: number;
  high: number;
  exact: number;
  iou: number;
  evidence: number;
};

type InternalMatch = {
  gold: LocatedGoldIssue;
  finding: Finding;
  exact: boolean;
  iou: number;
};

function emptyTally(): BenchmarkTally {
  return {
    tp: 0,
    fp: 0,
    fn: 0,
    critical_high_tp: 0,
    critical_high_gold: 0,
    evidence_covered: 0,
    evidence_required: 0,
    top5_tp: 0,
    exact_matches: 0,
    match_count: 0,
    overlap_sum: 0,
    validated_spans: 0,
    prediction_count: 0,
    ndcg_included: 0,
    ndcg_value: 0,
  };
}

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

function overlap(
  a: { start_offset: number; end_offset: number },
  b: { start_offset: number; end_offset: number },
): number {
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

function typesCompatible(goldType: FindingType, predictedType: FindingType): boolean {
  return goldType === predictedType;
}

function isValidSourceSpan(article: CanonicalArticle, span: SourceSpan): boolean {
  if (span.end_offset < span.start_offset || span.start_offset < 0 || span.quoted_text.length === 0) {
    return false;
  }
  const text = fieldText(article, span.field);
  if (span.end_offset > text.length) {
    return false;
  }
  return text.slice(span.start_offset, span.end_offset) === span.quoted_text;
}

function isReliableEvidenceItem(item: EvidenceItem): boolean {
  if (item.kind === "rule") {
    return Boolean(item.rule_id);
  }
  if (item.kind === "retrieved_source") {
    return Boolean(item.source_id) && Boolean(item.source_url);
  }
  return false;
}

function findingHasReliableEvidence(finding: Finding): boolean {
  return finding.evidence.some(isReliableEvidenceItem);
}

function dcg(rels: number[]): number {
  return rels.reduce((sum, rel, index) => sum + rel / Math.log2(index + 2), 0);
}

function collectEdges(
  article: CanonicalArticle,
  located: LocatedGoldIssue[],
  findings: Finding[],
): MatchEdge[] {
  const edges: MatchEdge[] = [];
  for (let goldIndex = 0; goldIndex < located.length; goldIndex += 1) {
    const gold = located[goldIndex];
    for (let findingIndex = 0; findingIndex < findings.length; findingIndex += 1) {
      const finding = findings[findingIndex];
      if (!typesCompatible(gold.type, finding.type)) {
        continue;
      }
      if (finding.source_span.field !== gold.field) {
        continue;
      }
      if (!isValidSourceSpan(article, finding.source_span)) {
        continue;
      }
      const exact =
        finding.source_span.start_offset === gold.start_offset &&
        finding.source_span.end_offset === gold.end_offset;
      const iou = overlap(finding.source_span, gold);
      if (!exact && iou < IOU_THRESHOLD) {
        continue;
      }
      edges.push({
        goldIndex,
        findingIndex,
        exact,
        iou: exact ? 1 : iou,
        score: exact ? 2 : iou,
        high: isHigh(gold.severity),
        evidenceCovered: gold.requires_evidence && findingHasReliableEvidence(finding),
      });
    }
  }
  return edges;
}

function edgesByGold(edges: MatchEdge[]): Map<number, MatchEdge[]> {
  const byGold = new Map<number, MatchEdge[]>();
  for (const edge of edges) {
    const list = byGold.get(edge.goldIndex) ?? [];
    list.push(edge);
    byGold.set(edge.goldIndex, list);
  }
  return byGold;
}

function maximumCardinality(findingCount: number, byGold: Map<number, MatchEdge[]>): number {
  const findingToGold: number[] = Array(findingCount).fill(-1);
  function dfs(goldIndex: number, seen: Set<number>): boolean {
    for (const edge of byGold.get(goldIndex) ?? []) {
      if (seen.has(edge.findingIndex)) {
        continue;
      }
      seen.add(edge.findingIndex);
      const current = findingToGold[edge.findingIndex];
      if (current === -1 || dfs(current, seen)) {
        findingToGold[edge.findingIndex] = goldIndex;
        return true;
      }
    }
    return false;
  }
  let count = 0;
  for (const goldIndex of byGold.keys()) {
    if (dfs(goldIndex, new Set())) {
      count += 1;
    }
  }
  return count;
}

function qualityOf(chosen: MatchEdge[]): MatchQuality {
  return {
    cardinality: chosen.length,
    high: chosen.filter((edge) => edge.high).length,
    exact: chosen.filter((edge) => edge.exact).length,
    iou: chosen.reduce((sum, edge) => sum + edge.iou, 0),
    evidence: chosen.filter((edge) => edge.evidenceCovered).length,
  };
}

function compareQuality(a: MatchQuality, b: MatchQuality): number {
  if (a.cardinality !== b.cardinality) {
    return a.cardinality - b.cardinality;
  }
  if (a.high !== b.high) {
    return a.high - b.high;
  }
  if (a.exact !== b.exact) {
    return a.exact - b.exact;
  }
  if (a.iou !== b.iou) {
    return a.iou - b.iou;
  }
  return a.evidence - b.evidence;
}

function matchingIdKey(
  chosen: MatchEdge[],
  located: LocatedGoldIssue[],
  findings: Finding[],
): string {
  return chosen
    .map((edge) => `${located[edge.goldIndex].issue_id}\0${findings[edge.findingIndex].finding_id}`)
    .sort()
    .join("\n");
}

function toInternalMatches(
  chosen: MatchEdge[],
  located: LocatedGoldIssue[],
  findings: Finding[],
): InternalMatch[] {
  const matches = chosen.map((edge) => ({
    gold: located[edge.goldIndex],
    finding: findings[edge.findingIndex],
    exact: edge.exact,
    iou: edge.iou,
  }));
  matches.sort((a, b) => {
    const goldCmp = a.gold.issue_id.localeCompare(b.gold.issue_id);
    if (goldCmp !== 0) {
      return goldCmp;
    }
    return a.finding.finding_id.localeCompare(b.finding.finding_id);
  });
  return matches;
}

function assignOneToOne(
  located: LocatedGoldIssue[],
  findings: Finding[],
  edges: MatchEdge[],
): InternalMatch[] {
  if (edges.length === 0) {
    return [];
  }
  const byGold = edgesByGold(edges);
  const maxCard = maximumCardinality(findings.length, byGold);
  const goldOrder = [...byGold.keys()].sort((a, b) => a - b);
  let best: MatchEdge[] = [];
  let bestQuality: MatchQuality = qualityOf(best);
  let bestIdKey = "";

  function dfs(goldOffset: number, usedFindings: Set<number>, chosen: MatchEdge[]): void {
    if (chosen.length + (goldOrder.length - goldOffset) < maxCard) {
      return;
    }
    if (goldOffset === goldOrder.length) {
      if (chosen.length < maxCard) {
        return;
      }
      const quality = qualityOf(chosen);
      const qualityCmp = compareQuality(quality, bestQuality);
      const idKey = matchingIdKey(chosen, located, findings);
      if (qualityCmp > 0 || (qualityCmp === 0 && (best.length === 0 || idKey < bestIdKey))) {
        best = chosen.slice();
        bestQuality = quality;
        bestIdKey = idKey;
      }
      return;
    }
    dfs(goldOffset + 1, usedFindings, chosen);
    for (const edge of byGold.get(goldOrder[goldOffset]) ?? []) {
      if (usedFindings.has(edge.findingIndex)) {
        continue;
      }
      usedFindings.add(edge.findingIndex);
      chosen.push(edge);
      dfs(goldOffset + 1, usedFindings, chosen);
      chosen.pop();
      usedFindings.delete(edge.findingIndex);
    }
  }

  dfs(0, new Set(), []);
  return toInternalMatches(best, located, findings);
}

function matchPredictions(
  article: CanonicalArticle,
  located: LocatedGoldIssue[],
  findings: Finding[],
): InternalMatch[] {
  return assignOneToOne(located, findings, collectEdges(article, located, findings));
}

function matchPredictionsRespectingRank(
  article: CanonicalArticle,
  located: LocatedGoldIssue[],
  findings: Finding[],
): InternalMatch[] {
  const edges = collectEdges(article, located, findings);
  const byFinding = new Map<number, MatchEdge[]>();
  for (const edge of edges) {
    const list = byFinding.get(edge.findingIndex) ?? [];
    list.push(edge);
    byFinding.set(edge.findingIndex, list);
  }
  const memo = new Map<string, { chosen: MatchEdge[]; suffixDcg: number }>();

  function stateKey(findingIndex: number, usedGold: Set<number>): string {
    return `${findingIndex}:${[...usedGold].sort((a, b) => a - b).join(",")}`;
  }

  function search(
    findingIndex: number,
    usedGold: Set<number>,
  ): { chosen: MatchEdge[]; suffixDcg: number } {
    const key = stateKey(findingIndex, usedGold);
    const cached = memo.get(key);
    if (cached) {
      return cached;
    }
    if (findingIndex >= findings.length) {
      const empty = { chosen: [] as MatchEdge[], suffixDcg: 0 };
      memo.set(key, empty);
      return empty;
    }
    const candidates = (byFinding.get(findingIndex) ?? []).filter((edge) => !usedGold.has(edge.goldIndex));
    if (candidates.length === 0) {
      const rest = search(findingIndex + 1, usedGold);
      memo.set(key, rest);
      return rest;
    }
    let bestChosen: MatchEdge[] = [];
    let bestDcg = Number.NEGATIVE_INFINITY;
    for (const edge of candidates) {
      usedGold.add(edge.goldIndex);
      const rest = search(findingIndex + 1, usedGold);
      usedGold.delete(edge.goldIndex);
      const totalDcg = 1 / Math.log2(findingIndex + 2) + rest.suffixDcg;
      if (totalDcg > bestDcg) {
        bestDcg = totalDcg;
        bestChosen = [edge, ...rest.chosen];
      }
    }
    const result = { chosen: bestChosen, suffixDcg: bestDcg };
    memo.set(key, result);
    return result;
  }

  return toInternalMatches(search(0, new Set()).chosen, located, findings);
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function metricsFromTally(tally: BenchmarkTally): Omit<BenchmarkMetrics, "latency_ms" | "cost_usd"> {
  return {
    overall_recall: ratio(tally.tp, tally.tp + tally.fn, 0),
    critical_high_recall: ratio(tally.critical_high_tp, tally.critical_high_gold, 0),
    precision: ratio(tally.tp, tally.tp + tally.fp, 0),
    fp_per_article: tally.fp,
    evidence_coverage: ratio(tally.evidence_covered, tally.evidence_required, 1),
    exact_span_rate: ratio(tally.exact_matches, tally.match_count, 0),
    mean_overlap: ratio(tally.overlap_sum, tally.match_count, 0),
    top5_recall: ratio(tally.top5_tp, tally.critical_high_gold, 0),
    ndcg_at_10: tally.ndcg_included === 0 ? 0 : tally.ndcg_value,
    span_validation: ratio(tally.validated_spans, tally.prediction_count, 1),
    tally,
  };
}

export function evaluateReview(article: CanonicalArticle, findings: Finding[], gold: GoldIssue[]): {
  metrics: Omit<BenchmarkMetrics, "latency_ms" | "cost_usd">;
  unmatchedGold: string[];
  unmatchedFindingIds: string[];
  goldLocateFailures: string[];
  matches: BenchmarkMatch[];
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
  if (goldLocateFailures.length > 0) {
    throw new GoldLocateFailureError(goldLocateFailures);
  }

  const matches = matchPredictions(article, located, findings);
  const matchedGoldIds = new Set(matches.map((item) => item.gold.issue_id));
  const matchedFindingIds = new Set(matches.map((item) => item.finding.finding_id));
  const unmatchedGold = located
    .filter((issue) => !matchedGoldIds.has(issue.issue_id))
    .map((item) => item.issue_id);
  const unmatchedFindingIds = findings
    .filter((finding) => !matchedFindingIds.has(finding.finding_id))
    .map((finding) => finding.finding_id);

  const highGold = located.filter((item) => isHigh(item.severity));
  const highMatches = matches.filter((item) => isHigh(item.gold.severity));
  const top5 = findings.slice(0, TOP_K);
  const top5Matches = matchPredictions(article, located, top5);
  const top5High = top5Matches.filter((item) => isHigh(item.gold.severity));

  const evidenceRequired = matches.filter((item) => item.gold.requires_evidence);
  const evidenceCovered = evidenceRequired.filter((item) => findingHasReliableEvidence(item.finding));
  const exactMatches = matches.filter((item) => item.exact).length;
  const overlapSum = matches.reduce((sum, item) => sum + item.iou, 0);
  const validated = findings.filter((finding) => isValidSourceSpan(article, finding.source_span)).length;

  const relevantGolds = highGold;
  const ranked = findings.slice(0, NDCG_K);
  const ndcgMatches = matchPredictionsRespectingRank(article, relevantGolds, ranked);
  const matchedRankIds = new Set(ndcgMatches.map((item) => item.finding.finding_id));
  const rels = ranked.map((finding) => (matchedRankIds.has(finding.finding_id) ? 1 : 0));
  const idealCount = Math.min(NDCG_K, relevantGolds.length);
  const ideal = Array.from({ length: idealCount }, () => 1);
  const idealDcg = dcg(ideal);
  const ndcg = relevantGolds.length === 0 || idealDcg === 0 ? 0 : dcg(rels) / idealDcg;

  const tally: BenchmarkTally = {
    tp: matches.length,
    fp: unmatchedFindingIds.length,
    fn: unmatchedGold.length,
    critical_high_tp: highMatches.length,
    critical_high_gold: highGold.length,
    evidence_covered: evidenceCovered.length,
    evidence_required: evidenceRequired.length,
    top5_tp: top5High.length,
    exact_matches: exactMatches,
    match_count: matches.length,
    overlap_sum: overlapSum,
    validated_spans: validated,
    prediction_count: findings.length,
    ndcg_included: relevantGolds.length > 0 ? 1 : 0,
    ndcg_value: ndcg,
  };

  return {
    unmatchedGold,
    unmatchedFindingIds,
    goldLocateFailures,
    matches: matches.map((item) => ({
      gold_id: item.gold.issue_id,
      finding_id: item.finding.finding_id,
      exact: item.exact,
      iou: item.iou,
    })),
    metrics: metricsFromTally(tally),
  };
}

export function averageMetrics(rows: BenchmarkMetrics[]): BenchmarkMetrics {
  if (rows.length === 0) {
    return {
      ...metricsFromTally(emptyTally()),
      fp_per_article: 0,
      latency_ms: null,
      cost_usd: null,
    };
  }

  const tally = rows.reduce((acc, row) => {
    const item = row.tally ?? emptyTally();
    return {
      tp: acc.tp + item.tp,
      fp: acc.fp + item.fp,
      fn: acc.fn + item.fn,
      critical_high_tp: acc.critical_high_tp + item.critical_high_tp,
      critical_high_gold: acc.critical_high_gold + item.critical_high_gold,
      evidence_covered: acc.evidence_covered + item.evidence_covered,
      evidence_required: acc.evidence_required + item.evidence_required,
      top5_tp: acc.top5_tp + item.top5_tp,
      exact_matches: acc.exact_matches + item.exact_matches,
      match_count: acc.match_count + item.match_count,
      overlap_sum: acc.overlap_sum + item.overlap_sum,
      validated_spans: acc.validated_spans + item.validated_spans,
      prediction_count: acc.prediction_count + item.prediction_count,
      ndcg_included: acc.ndcg_included + item.ndcg_included,
      ndcg_value: acc.ndcg_value + (item.ndcg_included > 0 ? item.ndcg_value : 0),
    };
  }, emptyTally());

  const hasCost = rows.some((row) => row.cost_usd != null);
  const hasLatency = rows.some((row) => row.latency_ms != null);
  const latencySum = rows.reduce((sum, row) => sum + (row.latency_ms ?? 0), 0);
  const costSum = rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);

  return {
    overall_recall: ratio(tally.tp, tally.tp + tally.fn, 0),
    critical_high_recall: ratio(tally.critical_high_tp, tally.critical_high_gold, 0),
    precision: ratio(tally.tp, tally.tp + tally.fp, 0),
    fp_per_article: tally.fp / rows.length,
    evidence_coverage: ratio(tally.evidence_covered, tally.evidence_required, 1),
    exact_span_rate: ratio(tally.exact_matches, tally.match_count, 0),
    mean_overlap: ratio(tally.overlap_sum, tally.match_count, 0),
    top5_recall: ratio(tally.top5_tp, tally.critical_high_gold, 0),
    ndcg_at_10: ratio(tally.ndcg_value, tally.ndcg_included, 0),
    span_validation: ratio(tally.validated_spans, tally.prediction_count, 1),
    latency_ms: hasLatency ? latencySum / rows.length : null,
    cost_usd: hasCost ? costSum / rows.length : null,
    tally,
  };
}
