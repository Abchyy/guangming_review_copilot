import type { EvidenceItem, Finding, Suggestion } from "@grc/contracts";
import { isAuthoritativeSource } from "@grc/retrieval";

export type DraftFinding = Omit<Finding, "finding_id"> & { finding_id?: string };

function spanKey(finding: DraftFinding): string {
  const span = finding.source_span;
  return `${span.field}:${span.start_offset}:${span.end_offset}`;
}

function spansOverlap(a: DraftFinding, b: DraftFinding): boolean {
  if (a.source_span.field !== b.source_span.field) {
    return false;
  }
  return (
    a.source_span.start_offset < b.source_span.end_offset &&
    b.source_span.start_offset < a.source_span.end_offset
  );
}

function itemStrength(item: EvidenceItem): number {
  if (item.kind === "rule") {
    return 4;
  }
  if (item.kind === "retrieved_source") {
    return isAuthoritativeSource(item.source_id) ? 4 : 3;
  }
  if (item.kind === "internal_context") {
    return 2;
  }
  return 1;
}

export function evidenceStrength(finding: DraftFinding): number {
  return finding.evidence.reduce((best, item) => Math.max(best, itemStrength(item)), 0);
}

function mergeEvidence(left: EvidenceItem[], right: EvidenceItem[]): EvidenceItem[] {
  const merged = [...left];
  for (const item of right) {
    const duplicate = merged.some(
      (existing) =>
        existing.kind === item.kind &&
        existing.excerpt === item.excerpt &&
        existing.rule_id === item.rule_id &&
        existing.source_id === item.source_id,
    );
    if (!duplicate) {
      merged.push(item);
    }
  }
  return merged;
}

function sameReplacement(a: Suggestion, b: Suggestion): boolean {
  return a.replacement === b.replacement;
}

function mergePair(primary: DraftFinding, other: DraftFinding): DraftFinding {
  return {
    ...primary,
    evidence: mergeEvidence(primary.evidence, other.evidence),
  };
}

export function fuseFindings(ruleFindings: DraftFinding[], llmFindings: DraftFinding[]): DraftFinding[] {
  const accepted: DraftFinding[] = [...ruleFindings];

  for (const llm of llmFindings) {
    const exactIndex = accepted.findIndex((item) => spanKey(item) === spanKey(llm));
    if (exactIndex >= 0) {
      const existing = accepted[exactIndex]!;
      if (sameReplacement(existing.suggestion, llm.suggestion)) {
        const primary = evidenceStrength(existing) >= evidenceStrength(llm) ? existing : llm;
        const other = primary === existing ? llm : existing;
        accepted[exactIndex] = mergePair(primary, other);
        continue;
      }
      const existingStrength = evidenceStrength(existing);
      const llmStrength = evidenceStrength(llm);
      if (existingStrength !== llmStrength) {
        const winner = existingStrength > llmStrength ? existing : llm;
        const loser = winner === existing ? llm : existing;
        accepted[exactIndex] = {
          ...mergePair(winner, loser),
          suggestion: winner.suggestion,
        };
        continue;
      }
      accepted[exactIndex] = {
        ...existing,
        title: "需人工核实的冲突修改建议",
        reason: `${existing.reason} 同时存在不同替换建议，无法自动判定。`,
        suggestion: {
          text: "同一位置存在不同替换建议，请人工核实。",
          replacement: null,
        },
        status: "verify",
        requires_verification: true,
        evidence: mergeEvidence(existing.evidence, llm.evidence),
      };
      continue;
    }

    const overlapIndex = accepted.findIndex((item) => spansOverlap(item, llm));
    if (overlapIndex >= 0) {
      const existing = accepted[overlapIndex]!;
      const winner = evidenceStrength(existing) >= evidenceStrength(llm) ? existing : llm;
      const loser = winner === existing ? llm : existing;
      accepted[overlapIndex] = mergePair(winner, loser);
      continue;
    }

    accepted.push(llm);
  }

  return accepted;
}
