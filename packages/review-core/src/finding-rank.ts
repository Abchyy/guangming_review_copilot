import type { Finding, FindingStatus, Severity } from "@grc/contracts";
import { isUnresolvedStatus } from "@grc/contracts";

export type RankableFinding = Pick<
  Finding,
  "status" | "severity" | "confidence" | "evidence" | "source_span"
>;

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function unresolvedRank(status: FindingStatus): number {
  if (status === "verify") {
    return 2;
  }
  if (isUnresolvedStatus(status)) {
    return 1;
  }
  return 0;
}

function evidenceClass(finding: RankableFinding): number {
  const hasRule = finding.evidence.some((item) => item.kind === "rule");
  const hasRetrieved = finding.evidence.some(
    (item) => item.kind === "retrieved_source" && Boolean(item.source_id),
  );
  if (hasRule || hasRetrieved) {
    return 4;
  }
  if (finding.evidence.some((item) => item.kind === "internal_context")) {
    return 2;
  }
  return 1;
}

function fieldRank(field: Finding["source_span"]["field"]): number {
  return field === "title" ? 1 : 0;
}

export function compareFindingsByRisk(a: RankableFinding, b: RankableFinding): number {
  const unresolved = unresolvedRank(b.status) - unresolvedRank(a.status);
  if (unresolved !== 0) {
    return unresolved;
  }
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) {
    return severity;
  }
  const evidence = evidenceClass(b) - evidenceClass(a);
  if (evidence !== 0) {
    return evidence;
  }
  const confidence = b.confidence - a.confidence;
  if (confidence !== 0) {
    return confidence;
  }
  const field = fieldRank(b.source_span.field) - fieldRank(a.source_span.field);
  if (field !== 0) {
    return field;
  }
  return a.source_span.start_offset - b.source_span.start_offset;
}

export function rankFindings<T extends RankableFinding>(findings: T[]): T[] {
  return findings.slice().sort(compareFindingsByRisk);
}
