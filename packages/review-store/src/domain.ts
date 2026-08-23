import type { FindingAction, FindingStatus } from "@grc/contracts";

export function canTransition(
  status: FindingStatus,
  action: FindingAction,
): boolean {
  if (action === "accept") {
    return status === "pending" || status === "verify";
  }
  if (action === "ignore" || action === "verify") {
    return status === "pending" || status === "verify";
  }
  return false;
}
