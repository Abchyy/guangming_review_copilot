/** @vitest-environment node */
import { readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runOfficialBlindInference } from "@/lib/server/benchmark/holdout/inference";
import { readCanonicalWorkspaceGit } from "@/lib/server/benchmark/holdout/git-state";
import { HOLDOUT_CUSTODIAN_HOME_ENV } from "@/lib/server/benchmark/holdout/lifecycle";
import {
  CANONICAL_PROVIDER_REQUEST_BOUNDARY,
  installCanonicalProviderRequestProbe,
} from "../helpers/canonical-provider-request-probe";
import {
  applyProtocolProviderEnv,
  setupOfficialTwoStage,
} from "../helpers/official-holdout-protocol";

describe("fresh-process official pre-inference probe", () => {
  test("legal two-stage path reaches the canonical DeepSeek request boundary without a prediction", async () => {
    if (!process.env[HOLDOUT_CUSTODIAN_HOME_ENV]) {
      throw new Error("HOLDOUT_CUSTODIAN_HOME is required");
    }
    applyProtocolProviderEnv();
    const live = readCanonicalWorkspaceGit();
    if (live.dirty) {
      throw new Error("Probe requires a clean canonical workspace");
    }

    const artifactDir =
      process.env.HOLDOUT_PROBE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "holdout-pre-inference-"));
    const setup = setupOfficialTwoStage({ artifactDir, holdoutId: "synthetic-locked-pre-inference" });
    const probe = installCanonicalProviderRequestProbe();
    try {
      await expect(
        runOfficialBlindInference({
          freeze: setup.systemFreeze,
          runFreeze: setup.runFreeze,
          inputPack: setup.inputPack,
          artifactDir,
        }),
      ).rejects.toThrow(new RegExp(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY}|DeepSeek provider unavailable`));
      expect(probe.requests.length).toBeGreaterThan(0);
      expect(probe.requests[0]?.origin).toBe(setup.systemFreeze.runtime.provider_endpoint);
      expect(probe.requests[0]?.account_boundary_id).toBe(setup.systemFreeze.runtime.account_boundary_id);
    } finally {
      probe.restore();
    }

    expect(readdirSync(artifactDir).filter((name) => name.startsWith("prediction-"))).toEqual([]);
    expect(readdirSync(artifactDir).some((name) => name.startsWith("system-freeze-"))).toBe(true);
    expect(readdirSync(artifactDir).some((name) => name.startsWith("run-freeze-"))).toBe(true);
  });
});
