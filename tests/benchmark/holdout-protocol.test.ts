/** @vitest-environment node */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadBenchmarkDataset, selectDevArticles, selectRegressionArticles } from "@/lib/server/benchmark/dataset";
import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { writeSealedJson } from "@/lib/server/benchmark/holdout/artifacts";
import { runProtocolDryRun } from "@/lib/server/benchmark/holdout/dry-run";
import { runControlledEvaluation } from "@/lib/server/benchmark/holdout/evaluation";
import {
  assertFreezeMatchesWorkspace,
  assertOfficialRuntime,
  createInferenceFreeze,
  freezeIdentity,
  officialFreezeRuntime,
} from "@/lib/server/benchmark/holdout/freeze";
import { loadGoldPack } from "@/lib/server/benchmark/holdout/gold-pack";
import { predictionIdentity } from "@/lib/server/benchmark/holdout/inference";
import { loadInputPack } from "@/lib/server/benchmark/holdout/input-pack";
import {
  LEGACY_LOCKED_HOLDOUT_ID,
  assertFreshOfficialHoldout,
  getHoldoutEntry,
  loadHoldoutRegistry,
  markHoldoutConsumed,
  protocolFixtureRegistry,
} from "@/lib/server/benchmark/holdout/lifecycle";

const repoRoot = process.cwd();

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("benchmark holdout protocol", () => {
  test("in-repo dataset is 6 dev / 12 regression and never official locked", () => {
    const raw = readFileSync(join(repoRoot, "data/benchmark/dataset.json"), "utf8");
    expect(raw).not.toMatch(/"split":\s*"locked"/);
    const dataset = loadBenchmarkDataset();
    expect(selectDevArticles(dataset)).toHaveLength(6);
    expect(selectRegressionArticles(dataset)).toHaveLength(12);
    expect(dataset.articles.every((item) => item.split === "dev" || item.split === "regression")).toBe(true);
    expect(dataset.regression_contamination.may_claim_fresh_locked_generalization).toBe(false);
  });

  test("legacy locked holdout is consumed and cannot be claimed as fresh official locked", () => {
    const registry = loadHoldoutRegistry();
    const legacy = getHoldoutEntry(registry, LEGACY_LOCKED_HOLDOUT_ID);
    expect(legacy.role).toBe("regression");
    expect(legacy.status).toBe("consumed");
    expect(legacy.contamination).toBe("inference_assets");
    expect(legacy.may_claim_fresh_locked_generalization).toBe(false);
    expect(() => assertFreshOfficialHoldout(legacy)).toThrow(HoldoutProtocolError);
    expect(() => markHoldoutConsumed(registry, LEGACY_LOCKED_HOLDOUT_ID)).toThrow(/already consumed/);
  });

  test("official freeze fails closed on a dirty working tree or enabled cache", () => {
    expect(() =>
      assertOfficialRuntime(officialFreezeRuntime({ application_cache: { enabled: true } })),
    ).toThrow(/cache/);
    expect(() =>
      createInferenceFreeze({
        purpose: "official",
        runtime: officialFreezeRuntime({ application_cache: { enabled: true } }),
      }),
    ).toThrow(/dirty|cache/);
  });

  test("protocol freeze fails closed when frozen assets later drift", () => {
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
    const drifted = {
      ...freeze,
      assets: freeze.assets.map((item) =>
        item.path === "src/lib/server/benchmark/evaluate.ts"
          ? { ...item, sha256: "0".repeat(64) }
          : item,
      ),
    };
    drifted.freeze_id = freezeIdentity(drifted);
    expect(() => assertFreezeMatchesWorkspace(drifted)).toThrow(/drifted/);
  });

  test("input-only loader refuses gold issues", () => {
    expect(() => loadInputPack(join(repoRoot, "data/benchmark/protocol-fixtures/gold.json"))).toThrow(
      /must not contain gold issues/,
    );
    expect(() => loadInputPack(join(repoRoot, "data/benchmark/dataset.json"))).toThrow(/gold issues|invalid|required/i);
  });

  test("blind inference module does not import gold or the evaluator", () => {
    const source = readFileSync(join(repoRoot, "src/lib/server/benchmark/holdout/inference.ts"), "utf8");
    expect(source).not.toMatch(/gold-pack/);
    expect(source).not.toMatch(/evaluateReview/);
    expect(source).not.toMatch(/loadBenchmarkDataset/);
    expect(source).not.toMatch(/loadGoldPack/);
  });

  test("controlled evaluation fails closed on freeze/prediction mismatch", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-mismatch-") });
    const inputPack = loadInputPack(join(repoRoot, "data/benchmark/protocol-fixtures/input.json"));
    const mismatched = {
      ...dry.prediction,
      freeze_id: "not-the-freeze",
    };
    mismatched.prediction_id = predictionIdentity(mismatched);
    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: mismatched,
        inputPack,
        goldPack: loadGoldPack(join(repoRoot, "data/benchmark/protocol-fixtures/gold.json")),
        registry: protocolFixtureRegistry(inputPack.articles.map((item) => item.article_id)),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-mismatch-eval-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/does not match freeze/);
  });

  test("sealed artifacts are not overwritten", () => {
    const filePath = join(tempDir("holdout-overwrite-"), "prediction-demo.json");
    writeSealedJson(filePath, { ok: true });
    expect(() => writeSealedJson(filePath, { ok: false })).toThrow(/overwrite/);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ ok: true });
  });

  test("consumed protocol fixture cannot be treated as a fresh locked holdout", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-consumed-") });
    expect(dry.registry.entries[0]?.status).toBe("consumed");
    expect(dry.registry.entries[0]?.may_claim_fresh_locked_generalization).toBe(false);
    expect(() => assertFreshOfficialHoldout(dry.registry.entries[0]!)).toThrow(HoldoutProtocolError);
    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        inputPack: loadInputPack(join(repoRoot, "data/benchmark/protocol-fixtures/input.json")),
        goldPack: loadGoldPack(join(repoRoot, "data/benchmark/protocol-fixtures/gold.json")),
        registry: dry.registry,
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-consumed-eval-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/already consumed|fresh locked/);
  });

  test("protocol dry-run freeze → input-only inference → sealed prediction → evaluation → result", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-dry-run-") });
    expect(dry.freeze.official).toBe(false);
    expect(dry.freeze.purpose).toBe("protocol_dry_run");
    expect(dry.prediction.official).toBe(false);
    expect(dry.prediction.claim).toBe("protocol_dry_run");
    expect(dry.prediction.articles).toHaveLength(1);
    expect(dry.prediction.articles[0]?.findings.length).toBeGreaterThan(0);
    expect(dry.result.official).toBe(false);
    expect(dry.result.claim).toBe("protocol_dry_run");
    expect(dry.result.freeze_id).toBe(dry.freeze.freeze_id);
    expect(dry.result.prediction_id).toBe(dry.prediction.prediction_id);
    expect(dry.result.holdout_status_after).toBe("consumed");
    expect(dry.result.metrics.tally.tp).toBeGreaterThanOrEqual(1);
    expect(dry.result.evaluator_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.result.prediction_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.result.dataset_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.result.article_ids).toEqual(["fixture-01"]);
    expect(readFileSync(join(dry.artifactDir, `freeze-${dry.freeze.freeze_id}.json`), "utf8")).toContain(dry.freeze.freeze_id);
    expect(readFileSync(join(dry.artifactDir, `prediction-${dry.prediction.prediction_id}.json`), "utf8")).toContain(
      dry.prediction.prediction_id,
    );
    expect(readFileSync(join(dry.artifactDir, `result-${dry.result.result_id}.json`), "utf8")).toContain(dry.result.result_id);
  });
});
