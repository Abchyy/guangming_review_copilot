import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureReviewModel } from "@grc/providers";
import { runControlledEvaluation, type HoldoutResultManifest } from "./evaluation";
import { createInferenceFreeze, type InferenceFreezeManifest } from "./freeze";
import { loadGoldPack } from "./gold-pack";
import { runBlindInference, type SealedPrediction } from "./inference";
import { loadInputPack } from "./input-pack";
import { canonicalWorkspaceRoot } from "./git-state";
import { writeCustodianLifecycle, protocolFixtureRegistry, type HoldoutRegistry } from "./lifecycle";

export const PROTOCOL_FIXTURE_INPUT = "data/benchmark/protocol-fixtures/input.json";
export const PROTOCOL_FIXTURE_GOLD = "data/benchmark/protocol-fixtures/gold.json";
export const PROTOCOL_FIXTURE_HOLDOUT_ID = "protocol-fixture-v1";

export type ProtocolDryRun = {
  artifactDir: string;
  freeze: InferenceFreezeManifest;
  prediction: SealedPrediction;
  result: HoldoutResultManifest;
  registry: HoldoutRegistry;
};

export async function runProtocolDryRun(options: {
  artifactDir?: string;
} = {}): Promise<ProtocolDryRun> {
  const artifactDir = options.artifactDir ?? mkdtempSync(join(tmpdir(), "holdout-dry-run-"));
  const workspace = canonicalWorkspaceRoot();
  const inputPack = loadInputPack(join(workspace, PROTOCOL_FIXTURE_INPUT));
  const goldPack = loadGoldPack(join(workspace, PROTOCOL_FIXTURE_GOLD));
  const freeze = createInferenceFreeze({
    purpose: "protocol_dry_run",
    runtime: {
      adapter_provider: "fixture",
      requested_model: null,
      prompt_mode: "copilot",
      application_cache: { enabled: false },
      retry: { max_attempts: 1, timeout_ms: null, max_tokens: null },
      provider_endpoint: null,
      account_boundary_id: null,
    },
  });
  const prediction = await runBlindInference({
    freeze,
    inputPack,
    model: new FixtureReviewModel([]),
    artifactDir,
  });
  const lifecyclePath = join(artifactDir, "holdout-lifecycle.json");
  writeCustodianLifecycle(
    lifecyclePath,
    protocolFixtureRegistry(inputPack.articles.map((item) => item.article_id)),
  );
  const evaluated = runControlledEvaluation({
    freeze,
    prediction,
    inputPack,
    goldPack,
    lifecyclePath,
    holdoutId: PROTOCOL_FIXTURE_HOLDOUT_ID,
    artifactDir,
  });
  if (evaluated.result.official || evaluated.result.claim !== "protocol_dry_run") {
    throw new Error("Protocol dry-run leaked an official locked claim");
  }
  return {
    artifactDir,
    freeze,
    prediction,
    result: evaluated.result,
    registry: evaluated.registry,
  };
}
