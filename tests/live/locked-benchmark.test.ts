/** @vitest-environment node */
import { beforeAll, describe, expect, test } from "vitest";

import { loadBenchmarkDataset } from "@/lib/server/benchmark/dataset";
import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import {
  LEGACY_LOCKED_HOLDOUT_ID,
  assertFreshOfficialHoldout,
  getHoldoutEntry,
  loadHoldoutRegistry,
} from "@/lib/server/benchmark/holdout/lifecycle";
import { LOCKED_INTENT, requireExplicitIntent } from "../helpers/live-intent";

/**
 * Official locked evaluation is not available in this development repo.
 * Start with `npm run test:locked`. An API key is not a start condition.
 * The former 12 locked articles are regression / legacy contaminated
 * and must not be reported as official locked generalization evidence.
 */
describe("M3 official locked evaluation gate (explicit opt-in only)", () => {
  beforeAll(() => {
    requireExplicitIntent(
      LOCKED_INTENT,
      "Run `npm run test:locked` instead of `npm test`.",
    );
  });

  test("refuses to treat in-repo data as official locked holdout", () => {
    const dataset = loadBenchmarkDataset();
    expect(dataset.articles.filter((item) => item.split === "dev")).toHaveLength(6);
    expect(dataset.articles.filter((item) => item.split === "regression")).toHaveLength(12);
    expect(dataset.articles.some((item) => (item.split as string) === "locked")).toBe(false);

    const legacy = getHoldoutEntry(loadHoldoutRegistry(), LEGACY_LOCKED_HOLDOUT_ID);
    expect(legacy.role).toBe("regression");
    expect(legacy.status).toBe("consumed");
    expect(legacy.may_claim_fresh_locked_generalization).toBe(false);
    expect(() => assertFreshOfficialHoldout(legacy)).toThrow(HoldoutProtocolError);
  });
});
