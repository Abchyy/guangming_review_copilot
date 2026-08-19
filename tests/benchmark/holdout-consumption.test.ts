/** @vitest-environment node */
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { sealedArtifactPath } from "@/lib/server/benchmark/holdout/artifacts";
import { runProtocolDryRun } from "@/lib/server/benchmark/holdout/dry-run";
import {
  assertOfficialLifecyclePath,
  canonicalOfficialLifecyclePath,
  claimHoldoutConsumption,
  HOLDOUT_CUSTODIAN_HOME_ENV,
  lifecycleEntryIdentity,
  loadCustodianLifecycle,
  protocolFixtureRegistry,
  syntheticLockedRegistry,
  writeCustodianLifecycle,
} from "@/lib/server/benchmark/holdout/lifecycle";
import {
  assertResultMatchesConsumedLifecycle,
  datasetIdentity,
  runControlledEvaluation,
} from "@/lib/server/benchmark/holdout/evaluation";
import type { InferenceFreezeManifest } from "@/lib/server/benchmark/holdout/freeze";
import { loadGoldPack } from "@/lib/server/benchmark/holdout/gold-pack";
import { sha256File } from "@/lib/server/benchmark/holdout/identity";
import { loadInputPack } from "@/lib/server/benchmark/holdout/input-pack";
import { canonicalWorkspaceRoot } from "@/lib/server/workspace-identity";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureInput() {
  return loadInputPack(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/input.json"));
}

function fixtureGold() {
  return loadGoldPack(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/gold.json"));
}

function officialIntentFreeze(): InferenceFreezeManifest {
  return {
    official: true,
    purpose: "official",
  } as InferenceFreezeManifest;
}

function writeExternalLockedGold() {
  const dir = tempDir("holdout-ext-gold-");
  const source = JSON.parse(
    readFileSync(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/gold.json"), "utf8"),
  ) as { role: string };
  source.role = "locked";
  const filePath = join(dir, "gold.json");
  writeFileSync(filePath, `${JSON.stringify(source, null, 2)}\n`);
  return loadGoldPack(filePath);
}

function placeholderPrediction(predictionId = "a".repeat(64)) {
  return {
    schema_version: "holdout-prediction.v1" as const,
    prediction_id: predictionId,
    freeze_id: "placeholder",
    input_pack_id: "placeholder",
    input_content_sha256: "b".repeat(64),
    role: "locked" as const,
    official: true,
    claim: "official_locked" as const,
    created_at: new Date().toISOString(),
    articles: [],
  };
}

function withCustodianHome<T>(run: (home: string) => T): T {
  const home = tempDir("holdout-custodian-");
  const previous = process.env[HOLDOUT_CUSTODIAN_HOME_ENV];
  process.env[HOLDOUT_CUSTODIAN_HOME_ENV] = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) {
      delete process.env[HOLDOUT_CUSTODIAN_HOME_ENV];
    } else {
      process.env[HOLDOUT_CUSTODIAN_HOME_ENV] = previous;
    }
  }
}

function copySealedPrediction(sourceDir: string, predictionId: string, destinationDir: string): string {
  const destination = sealedArtifactPath(destinationDir, "prediction", predictionId);
  copyFileSync(sealedArtifactPath(sourceDir, "prediction", predictionId), destination);
  return destination;
}

describe("holdout consumption and artifact integrity", () => {
  test("consumed status survives reload from the custodian lifecycle file", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-persist-") });
    const lifecyclePath = join(dry.artifactDir, "holdout-lifecycle.json");
    const reloaded = loadCustodianLifecycle(lifecyclePath);
    expect(reloaded.entries[0]?.status).toBe("consumed");
    expect(reloaded.entries[0]?.may_claim_fresh_locked_generalization).toBe(false);
    expect(reloaded.entries[0]?.result_id).toBe(dry.result.result_id);

    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        inputPack: fixtureInput(),
        goldPack: fixtureGold(),
        lifecyclePath,
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-persist-reuse-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/already claimed or consumed|already consumed|cannot be consumed as fresh/);
  });

  test("two exclusive claims cannot both treat the same holdout as fresh", () => {
    const lifecyclePath = join(tempDir("holdout-claim-"), "lifecycle.json");
    writeCustodianLifecycle(lifecyclePath, protocolFixtureRegistry(["fixture-01"]));
    const first = claimHoldoutConsumption(lifecyclePath, "protocol-fixture-v1");
    expect(first.entries[0]?.status).toBe("consuming");
    expect(() => claimHoldoutConsumption(lifecyclePath, "protocol-fixture-v1")).toThrow(
      /already claimed or consumed/,
    );
    expect(loadCustodianLifecycle(lifecyclePath).entries[0]?.status).toBe("consuming");
  });

  test("two isolated processes cannot both claim the same fresh holdout", async () => {
    const lifecyclePath = join(tempDir("holdout-race-"), "lifecycle.json");
    writeCustodianLifecycle(lifecyclePath, protocolFixtureRegistry(["fixture-01"]));
    const vitestBin = join(canonicalWorkspaceRoot(), "node_modules", ".bin", "vitest");
    const env = {
      ...process.env,
      HOLDOUT_LIFECYCLE_PATH: lifecyclePath,
      HOLDOUT_ID: "protocol-fixture-v1",
    };
    const spawnProbe = () =>
      new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const child = spawn(vitestBin, ["run", "--config", "vitest.consume-race.config.mts"], {
          cwd: canonicalWorkspaceRoot(),
          env,
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.on("close", (status) => resolve({ status, stdout }));
      });
    const [left, right] = await Promise.all([spawnProbe(), spawnProbe()]);
    const successes = [left, right].filter((item) => item.status === 0);
    const failures = [left, right].filter((item) => item.status !== 0);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(loadCustodianLifecycle(lifecyclePath).entries[0]?.status).toBe("consuming");
  });

  test("edited prediction artifact is rejected even if the self-reported id is kept", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-tamper-src-") });
    const originalPath = sealedArtifactPath(dry.artifactDir, "prediction", dry.prediction.prediction_id);
    const tamperedDir = tempDir("holdout-tamper-");
    const tamperedPath = join(tamperedDir, `prediction-${dry.prediction.prediction_id}.json`);
    const parsed = JSON.parse(readFileSync(originalPath, "utf8")) as {
      prediction_id: string;
      articles: Array<{ findings: unknown[] }>;
    };
    parsed.articles[0]!.findings = [];
    writeFileSync(tamperedPath, `${JSON.stringify(parsed, null, 2)}\n`);

    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        predictionPath: tamperedPath,
        inputPack: fixtureInput(),
        goldPack: fixtureGold(),
        registry: protocolFixtureRegistry(["fixture-01"]),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tamperedDir,
        verifyWorkspace: false,
      }),
    ).toThrow(/Prediction identity does not match sealed prediction contents/);
  });

  test("article set mismatches across registry / input / gold / prediction are rejected", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-articles-src-") });
    const extraGoldDir = tempDir("holdout-extra-gold-");
    const extraGoldPath = join(extraGoldDir, "gold.json");
    const gold = JSON.parse(
      readFileSync(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/gold.json"), "utf8"),
    ) as {
      articles: Array<Record<string, unknown>>;
    };
    gold.articles.push({
      ...gold.articles[0],
      article_id: "fixture-extra",
    });
    writeFileSync(extraGoldPath, `${JSON.stringify(gold, null, 2)}\n`);

    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        inputPack: fixtureInput(),
        goldPack: loadGoldPack(extraGoldPath),
        registry: protocolFixtureRegistry(["fixture-01"]),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-extra-eval-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/article set does not match the holdout dataset/);
  });

  test("same outer pack ids with different content identities are rejected", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-content-src-") });
    const mutatedDir = tempDir("holdout-content-");
    const mutatedGoldPath = join(mutatedDir, "gold.json");
    const gold = JSON.parse(
      readFileSync(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/gold.json"), "utf8"),
    ) as {
      pack_id: string;
      articles: Array<{ body: string; issues: Array<{ quoted_text: string }> }>;
    };
    gold.articles[0]!.body = "工作人员表示，新设备已经安装到位。";
    gold.articles[0]!.issues[0]!.quoted_text = "安装";
    writeFileSync(mutatedGoldPath, `${JSON.stringify(gold, null, 2)}\n`);

    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        inputPack: fixtureInput(),
        goldPack: loadGoldPack(mutatedGoldPath),
        registry: protocolFixtureRegistry(["fixture-01"]),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-content-eval-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/Input identity mismatch|Prediction input content identity|content identity/);
  });

  test("result manifest binds the actual freeze / input / prediction / gold / evaluator identities", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-bind-") });
    const predictionPath = sealedArtifactPath(dry.artifactDir, "prediction", dry.prediction.prediction_id);
    const inputPack = fixtureInput();
    const goldPack = fixtureGold();
    expect(dry.result.freeze_id).toBe(dry.freeze.freeze_id);
    expect(dry.result.prediction_id).toBe(dry.prediction.prediction_id);
    expect(dry.result.prediction_artifact_sha256).toBe(sha256File(predictionPath));
    expect(dry.result.input_pack_id).toBe(inputPack.pack_id);
    expect(dry.result.input_content_sha256).toBe(inputPack.content_sha256);
    expect(dry.result.gold_pack_id).toBe(goldPack.pack_id);
    expect(dry.result.gold_content_sha256).toBe(goldPack.content_sha256);
    expect(dry.result.evaluator_sha256).toBe(
      dry.freeze.assets.find((item) => item.path === "src/lib/server/benchmark/evaluate.ts")?.sha256,
    );
    expect(dry.result.dataset_sha256).toBe(
      datasetIdentity({
        holdout_id: "protocol-fixture-v1",
        role: "protocol_fixture",
        article_ids: ["fixture-01"],
        input_content_sha256: inputPack.content_sha256,
        gold_content_sha256: goldPack.content_sha256,
      }),
    );
    expect(dry.result.holdout_lifecycle_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("official lifecycle cannot live in the development repo", () => {
    expect(() =>
      assertOfficialLifecyclePath(join(canonicalWorkspaceRoot(), "data/benchmark/holdout-registry.json")),
    ).toThrow(/outside the development repo/);
  });

  test("official evaluation refuses a missing sealed prediction file", () => {
    expect(() =>
      runControlledEvaluation({
        freeze: officialIntentFreeze(),
        prediction: placeholderPrediction(),
        inputPack: fixtureInput(),
        goldPack: writeExternalLockedGold(),
        holdoutId: "synthetic-locked-v1",
        artifactDir: tempDir("holdout-official-missing-pred-"),
      }),
    ).toThrow(/sealed prediction artifact/);
  });

  test("official evaluation refuses an in-memory prediction when the artifact is missing", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-official-memory-src-") });
    expect(() =>
      runControlledEvaluation({
        freeze: officialIntentFreeze(),
        prediction: dry.prediction,
        inputPack: fixtureInput(),
        goldPack: writeExternalLockedGold(),
        holdoutId: "synthetic-locked-v1",
        artifactDir: tempDir("holdout-official-memory-eval-"),
      }),
    ).toThrow(/sealed prediction artifact/);
  });

  test("official evaluation refuses a modified sealed prediction artifact", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-official-tamper-src-") });
    const artifactDir = tempDir("holdout-official-tamper-");
    const tamperedPath = copySealedPrediction(dry.artifactDir, dry.prediction.prediction_id, artifactDir);
    const parsed = JSON.parse(readFileSync(tamperedPath, "utf8")) as {
      prediction_id: string;
      articles: Array<{ findings: unknown[] }>;
    };
    parsed.articles[0]!.findings = [];
    writeFileSync(tamperedPath, `${JSON.stringify(parsed, null, 2)}\n`);

    expect(() =>
      runControlledEvaluation({
        freeze: officialIntentFreeze(),
        prediction: dry.prediction,
        inputPack: fixtureInput(),
        goldPack: writeExternalLockedGold(),
        holdoutId: "synthetic-locked-v1",
        artifactDir,
      }),
    ).toThrow(/Prediction identity does not match sealed prediction contents/);
  });

  test("official evaluation cannot be redirected to a fresh lifecycle path after consume", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-redirect-src-") });
    const holdoutId = "synthetic-locked-v1";
    withCustodianHome((home) => {
      const consumed = syntheticLockedRegistry({ holdoutId, articleIds: ["fixture-01"] });
      consumed.entries[0] = {
        ...consumed.entries[0]!,
        status: "consumed",
        may_claim_fresh_locked_generalization: false,
        result_id: "c".repeat(64),
      };
      writeCustodianLifecycle(canonicalOfficialLifecyclePath(holdoutId), consumed);

      const otherPath = join(tempDir("holdout-other-lifecycle-"), "lifecycle.json");
      writeCustodianLifecycle(otherPath, syntheticLockedRegistry({ holdoutId, articleIds: ["fixture-01"] }));

      expect(() =>
        runControlledEvaluation({
          freeze: officialIntentFreeze(),
          prediction: dry.prediction,
          inputPack: fixtureInput(),
          goldPack: writeExternalLockedGold(),
          lifecyclePath: otherPath,
          holdoutId,
          artifactDir: tempDir("holdout-redirect-lifecycle-"),
        }),
      ).toThrow(/redirected by the caller/);

      const artifactDir = tempDir("holdout-canonical-consumed-");
      copySealedPrediction(dry.artifactDir, dry.prediction.prediction_id, artifactDir);
      expect(canonicalOfficialLifecyclePath(holdoutId).startsWith(realpathSync(home))).toBe(true);
      expect(() =>
        runControlledEvaluation({
          freeze: officialIntentFreeze(),
          prediction: dry.prediction,
          inputPack: fixtureInput(),
          goldPack: writeExternalLockedGold(),
          holdoutId,
          artifactDir,
        }),
      ).toThrow(/consumed|cannot be used as fresh/);
    });
  });

  test("changing the artifact directory does not change official holdout lifecycle identity", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-artifact-id-src-") });
    const holdoutId = "synthetic-locked-v1";
    withCustodianHome((home) => {
      const consumed = syntheticLockedRegistry({ holdoutId, articleIds: ["fixture-01"] });
      consumed.entries[0] = {
        ...consumed.entries[0]!,
        status: "consumed",
        may_claim_fresh_locked_generalization: false,
        result_id: "d".repeat(64),
      };
      const canonicalPath = canonicalOfficialLifecyclePath(holdoutId);
      writeCustodianLifecycle(canonicalPath, consumed);
      expect(canonicalPath).toBe(join(realpathSync(home), "holdouts", holdoutId, "lifecycle.json"));

      const evalAt = (prefix: string) => {
        const artifactDir = tempDir(prefix);
        copySealedPrediction(dry.artifactDir, dry.prediction.prediction_id, artifactDir);
        expect(() =>
          runControlledEvaluation({
            freeze: officialIntentFreeze(),
            prediction: dry.prediction,
            inputPack: fixtureInput(),
            goldPack: writeExternalLockedGold(),
            holdoutId,
            artifactDir,
          }),
        ).toThrow(/consumed|cannot be used as fresh/);
      };

      evalAt("holdout-artifact-a-");
      evalAt("holdout-artifact-b-");
      expect(loadCustodianLifecycle(canonicalPath).entries[0]?.status).toBe("consumed");
      expect(loadCustodianLifecycle(canonicalPath).entries[0]?.result_id).toBe("d".repeat(64));
    });
  });

  test("final persisted consumed lifecycle can be verified against the result manifest", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-verify-lifecycle-") });
    const persisted = loadCustodianLifecycle(join(dry.artifactDir, "holdout-lifecycle.json")).entries[0]!;
    expect(persisted.status).toBe("consumed");
    expect(persisted.result_id).toBe(dry.result.result_id);
    expect(() => assertResultMatchesConsumedLifecycle(dry.result, persisted)).not.toThrow();
    expect(dry.result.holdout_lifecycle_sha256).toBe(lifecycleEntryIdentity(persisted));
    expect(lifecycleEntryIdentity(persisted)).toBe(
      lifecycleEntryIdentity(protocolFixtureRegistry(["fixture-01"]).entries[0]!),
    );
  });
});
