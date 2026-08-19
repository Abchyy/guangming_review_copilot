import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";

export const DATASET_ROLES = ["dev", "regression"] as const;
export const HOLDOUT_ROLES = ["dev", "regression", "locked", "protocol_fixture"] as const;
export const HOLDOUT_STATUSES = ["available", "consuming", "consumed"] as const;
export const RESULT_CLAIMS = [
  "protocol_dry_run",
  "dev_diagnostic",
  "regression_contaminated",
  "official_locked",
] as const;
export const FREEZE_PURPOSES = ["official", "protocol_dry_run"] as const;

export type DatasetRole = (typeof DATASET_ROLES)[number];
export type HoldoutRole = (typeof HOLDOUT_ROLES)[number];
export type HoldoutStatus = (typeof HOLDOUT_STATUSES)[number];
export type ResultClaim = (typeof RESULT_CLAIMS)[number];
export type FreezePurpose = (typeof FREEZE_PURPOSES)[number];

export function claimForRole(role: HoldoutRole, purpose: FreezePurpose): ResultClaim {
  if (purpose === "protocol_dry_run") {
    return "protocol_dry_run";
  }
  if (role === "dev") {
    return "dev_diagnostic";
  }
  if (role === "regression" || role === "protocol_fixture") {
    return "regression_contaminated";
  }
  return "official_locked";
}

export function assertNotOfficialLockedClaim(input: {
  official: boolean;
  claim: ResultClaim;
  role: HoldoutRole;
}): void {
  if (input.official && input.claim !== "official_locked") {
    throw new HoldoutProtocolError(
      `Refusing official flag on non-locked claim ${input.claim} (role=${input.role})`,
    );
  }
  if (input.claim === "official_locked" && input.role !== "locked") {
    throw new HoldoutProtocolError(
      `Refusing official locked claim for role ${input.role}. Former locked articles are regression / legacy contaminated.`,
    );
  }
  if (input.role === "regression" && (input.official || input.claim === "official_locked")) {
    throw new HoldoutProtocolError(
      "Regression / legacy contaminated data cannot be reported as official locked generalization evidence",
    );
  }
}
