import { isUnresolvedStatus, type CreateReviewResponse, type Finding } from "@grc/contracts";
import { sortFindingsForDisplay } from "@/lib/highlight-segments";

export function unresolvedFindings(findings: Finding[]): Finding[] {
  return sortFindingsForDisplay(findings).filter((finding) =>
    isUnresolvedStatus(finding.status),
  );
}

export function selectAfterDecision(
  previousSelectedId: string | null,
  previousReview: CreateReviewResponse,
  nextReview: CreateReviewResponse,
): string | null {
  const unresolved = unresolvedFindings(nextReview.findings);
  if (unresolved.length === 0) {
    return null;
  }

  const previous = previousReview.findings.find(
    (finding) => finding.finding_id === previousSelectedId,
  );
  const current = nextReview.findings.find(
    (finding) => finding.finding_id === previousSelectedId,
  );

  if (current && isUnresolvedStatus(current.status)) {
    return current.finding_id;
  }

  if (
    previous &&
    (previous.status !== current?.status ||
      current?.status === "accepted" ||
      current?.status === "invalidated")
  ) {
    const ordered = sortFindingsForDisplay(nextReview.findings);
    const start = ordered.findIndex((finding) => finding.finding_id === previousSelectedId);
    const rotated = start >= 0 ? [...ordered.slice(start + 1), ...ordered.slice(0, start)] : ordered;
    const next = rotated.find((finding) => isUnresolvedStatus(finding.status));
    return next?.finding_id ?? unresolved[0]?.finding_id ?? null;
  }

  return previousSelectedId ?? unresolved[0]?.finding_id ?? null;
}
