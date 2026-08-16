import type { Finding, Severity } from "@/lib/contracts/review";
import { isUnresolvedStatus } from "@/lib/contracts/review";

export type TextSegment = {
  start: number;
  end: number;
  text: string;
  findingIds: string[];
  primaryFindingId: string | null;
  primarySeverity: Severity | null;
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function compareFindings(a: Finding, b: Finding): number {
  const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return a.finding_id.localeCompare(b.finding_id);
}

export function segmentField(
  text: string,
  findings: Finding[],
  field: "title" | "body",
): TextSegment[] {
  const relevant = findings.filter(
    (finding) =>
      isUnresolvedStatus(finding.status) &&
      finding.source_span.field === field &&
      finding.source_span.start_offset >= 0 &&
      finding.source_span.end_offset <= text.length &&
      finding.source_span.end_offset > finding.source_span.start_offset,
  );

  const points = new Set<number>([0, text.length]);
  for (const finding of relevant) {
    points.add(finding.source_span.start_offset);
    points.add(finding.source_span.end_offset);
  }

  const sorted = [...points].sort((a, b) => a - b);
  const segments: TextSegment[] = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start === end) {
      continue;
    }

    const covering = relevant.filter(
      (finding) =>
        finding.source_span.start_offset <= start &&
        finding.source_span.end_offset >= end,
    );
    covering.sort(compareFindings);

    segments.push({
      start,
      end,
      text: text.slice(start, end),
      findingIds: covering.map((finding) => finding.finding_id),
      primaryFindingId: covering[0]?.finding_id ?? null,
      primarySeverity: covering[0]?.severity ?? null,
    });
  }

  return segments;
}

export function sortFindingsForDisplay(findings: Finding[]): Finding[] {
  return findings.slice().sort(compareFindings);
}
