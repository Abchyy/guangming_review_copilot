import type { FindingType, ModelSpecialistId, SpecialistId, SpecialistSkip } from "@grc/contracts";
import { MODEL_SPECIALIST_IDS } from "@grc/contracts";

import { specialistBudgetLimit } from "./config";
import { SPECIALIST_ROLE_FINDING_TYPES, isModelSpecialistId } from "./roles";

export const SPECIALIST_DISPATCH_PRIORITY: readonly SpecialistId[] = [
  "fact_check",
  "news_edit",
  "entity",
  "policy",
  "numeric",
  "citation",
];

export function specialistIdsForFindings(
  findings: ReadonlyArray<{ type: FindingType }>,
): ModelSpecialistId[] {
  const needed = new Set<ModelSpecialistId>();
  for (const finding of findings) {
    for (const id of MODEL_SPECIALIST_IDS) {
      if (SPECIALIST_ROLE_FINDING_TYPES[id].includes(finding.type)) {
        needed.add(id);
      }
    }
  }
  return SPECIALIST_DISPATCH_PRIORITY.filter((id): id is ModelSpecialistId =>
    isModelSpecialistId(id) && needed.has(id),
  );
}

export function selectSpecialists(input: {
  findings: ReadonlyArray<{ type: FindingType }>;
  available: readonly SpecialistId[];
  maxSpecialists?: number;
}): { dispatched: SpecialistId[]; skipped: SpecialistSkip[] } {
  const max = specialistBudgetLimit(input.maxSpecialists);
  const available = new Set(input.available);
  const needed = specialistIdsForFindings(input.findings);
  const skipped: SpecialistSkip[] = [];
  const eligible: SpecialistId[] = [];

  for (const id of needed) {
    if (!available.has(id)) {
      skipped.push({ specialist: id, reason: "specialist not registered" });
      continue;
    }
    eligible.push(id);
  }

  const dispatched = eligible.slice(0, max);
  for (const id of eligible.slice(max)) {
    skipped.push({ specialist: id, reason: "call budget" });
  }
  return { dispatched, skipped };
}
