import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import { runControlledEvaluation, type HoldoutResultManifest } from "@/lib/server/benchmark/holdout/evaluation";
import { createInferenceFreeze, type InferenceFreezeManifest } from "@/lib/server/benchmark/holdout/freeze";
import { loadGoldPack } from "@/lib/server/benchmark/holdout/gold-pack";
import { runBlindInference, type SealedPrediction } from "@/lib/server/benchmark/holdout/inference";
import { loadInputPack } from "@/lib/server/benchmark/holdout/input-pack";
import { canonicalWorkspaceRoot } from "@/lib/server/benchmark/holdout/git-state";
import { writeCustodianLifecycle, protocolFixtureRegistry, type HoldoutRegistry } from "@/lib/server/benchmark/holdout/lifecycle";

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
