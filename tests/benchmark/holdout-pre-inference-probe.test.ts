/** @vitest-environment node */
import { readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runOfficialBlindInference } from "@/lib/server/benchmark/holdout/inference";
import { readCanonicalWorkspaceGit } from "@/lib/server/benchmark/holdout/git-state";
import { HOLDOUT_CUSTODIAN_HOME_ENV } from "@/lib/server/benchmark/holdout/lifecycle";
import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import {
  PROTOCOL_TEST_PROVIDER_KEY,
  applyProtocolProviderEnv,
  setupOfficialTwoStage,
} from "../helpers/official-holdout-protocol";

describe("fresh-process official pre-inference probe", () => {
  test("legal two-stage path reaches the DeepSeek call boundary without a prediction", async () => {
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
    const reached = { value: false };
    const model = new DeepSeekReviewModel({
      apiKey: PROTOCOL_TEST_PROVIDER_KEY,
      client: {
        chat: {
          completions: {
            create: async () => {
              reached.value = true;
              throw new Error("PROVIDER_CALL_BOUNDARY");
            },
          },
        },
      } as never,
    });

    await expect(
      runOfficialBlindInference({
        freeze: setup.systemFreeze,
        runFreeze: setup.runFreeze,
        inputPack: setup.inputPack,
        model,
        artifactDir,
      }),
    ).rejects.toThrow(/PROVIDER_CALL_BOUNDARY|DeepSeek provider unavailable/);

    expect(reached.value).toBe(true);
    expect(readdirSync(artifactDir).filter((name) => name.startsWith("prediction-"))).toEqual([]);
    expect(readdirSync(artifactDir).some((name) => name.startsWith("system-freeze-"))).toBe(true);
    expect(readdirSync(artifactDir).some((name) => name.startsWith("run-freeze-"))).toBe(true);
  });
});
