import type { Severity } from "@grc/contracts";
import type { DraftFinding } from "./fusion";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function atLeast(severity: Severity, floor: Severity): Severity {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor] ? severity : floor;
}

function atMost(severity: Severity, ceiling: Severity): Severity {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[ceiling] ? severity : ceiling;
}

function ruleIds(finding: DraftFinding): string[] {
  return finding.evidence
    .map((item) => item.rule_id)
    .filter((value): value is string => typeof value === "string");
}

function isModelOnly(finding: DraftFinding): boolean {
  return finding.evidence.length > 0 && finding.evidence.every((item) => item.kind === "ai_judgment");
}

function hasRule(finding: DraftFinding): boolean {
  return finding.evidence.some((item) => item.kind === "rule");
}

function hasAuthoritativeRetrieved(finding: DraftFinding): boolean {
  return finding.evidence.some((item) => item.kind === "retrieved_source");
}

export function overrideSeverity(finding: DraftFinding): DraftFinding {
  let severity = finding.severity;
  let requiresVerification = Boolean(finding.requires_verification);
  const ids = ruleIds(finding);

  if (ids.some((id) => id.startsWith("typo.")) || ids.includes("punct.repeated")) {
    severity = "low";
  } else if (finding.type === "basic_text" && !hasRule(finding) && !hasAuthoritativeRetrieved(finding)) {
    severity = atMost(severity, "medium");
  }

  if (ids.includes("datetime.weekday-mismatch")) {
    severity = atLeast(severity, "high");
  }
  if (ids.some((id) => id.startsWith("metric."))) {
    severity = atLeast(severity, "high");
  }
  if (
    (finding.type === "person" || finding.type === "organization" || finding.type === "policy") &&
    (hasRule(finding) || hasAuthoritativeRetrieved(finding))
  ) {
    severity = atLeast(severity, "high");
  }

  if (isModelOnly(finding) && severity === "critical") {
    severity = "high";
    requiresVerification = true;
  }
  if (isModelOnly(finding)) {
    requiresVerification = true;
  }

  return {
    ...finding,
    severity,
    requires_verification: requiresVerification,
  };
}

export function applySeverityOverrides(findings: DraftFinding[]): DraftFinding[] {
  return findings.map(overrideSeverity);
}
