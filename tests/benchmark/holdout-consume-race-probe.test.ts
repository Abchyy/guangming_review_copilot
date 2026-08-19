/** @vitest-environment node */
import { describe, expect, test } from "vitest";

import { claimHoldoutConsumption } from "@/lib/server/benchmark/holdout/lifecycle";

describe("holdout consume race probe", () => {
  test("claims the configured holdout once", () => {
    const lifecyclePath = process.env.HOLDOUT_LIFECYCLE_PATH;
    const holdoutId = process.env.HOLDOUT_ID;
    if (!lifecyclePath || !holdoutId) {
      throw new Error("HOLDOUT_LIFECYCLE_PATH and HOLDOUT_ID are required");
    }
    const registry = claimHoldoutConsumption(lifecyclePath, holdoutId);
    expect(registry.entries.find((item) => item.holdout_id === holdoutId)?.status).toBe("consuming");
  });
});
