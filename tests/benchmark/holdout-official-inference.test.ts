/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, beforeEach } from "vitest";

import { runControlledEvaluation } from "@grc/holdout-protocol";
import {
  FREEZE_SCHEMA_VERSION,
  assertOfficialFreezeAssetInventory,
  assertOfficialFreezeUsable,
  assertOfficialRuntime,
  createInferenceFreeze,
  freezeIdentity,
  hashFreezeAssets,
  officialFreezeRuntime,
  type InferenceFreezeManifest,
} from "@grc/holdout-protocol";
import { observeOfficialProviderBoundary } from "@grc/holdout-protocol";
import { applyProtocolProviderEnv, setupOfficialTwoStage, withCustodianHomeAsync } from "@grc/test-kit";
import {
  canonicalWorkspaceRoot,
  readCanonicalWorkspaceGit,
  rejectCallerWorkspaceOverride,
} from "@grc/holdout-protocol";
import {
  assertOfficialInferenceProvenance,
  runOfficialBlindInference,
} from "@grc/holdout-protocol";
import { loadInputPack } from "@grc/holdout-protocol";
import { loadGoldPack } from "@grc/holdout-protocol";
import { protocolFixtureRegistry } from "@grc/holdout-protocol";
import { OUTPUT_SCHEMA_VERSION, PROMPT_VERSION } from "@grc/providers";
import { getCorpusVersion } from "@grc/retrieval";
import { getRuleVersion } from "@grc/rules-engine";
import { OFFICIAL_BENCHMARK_MODEL } from "@grc/providers";
import {
  ScriptedReviewModel,
  officialAttempt,
  officialSuccessProvenance,
} from "@grc/test-kit";

const workspace = canonicalWorkspaceRoot();

beforeEach(() => {
  applyProtocolProviderEnv();
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExternalLockedInput(): ReturnType<typeof loadInputPack> {
  const dir = tempDir("holdout-external-locked-");
  const filePath = join(dir, "input.json");
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        schema_version: "holdout-input.v1",
        pack_id: "external-locked-input-v1",
        role: "locked",
        articles: [
          {
            article_id: "ext-01",
            title: "外部输入稿",
            body: "这是一份不含标注的 repo 外 locked input。",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return loadInputPack(filePath);
}

function reseal(freeze: InferenceFreezeManifest): InferenceFreezeManifest {
  return {
    ...freeze,
    freeze_id: freezeIdentity(freeze),
  };
}

function synthesizeOfficialFreezeDocument(
  overrides: Partial<InferenceFreezeManifest> = {},
): InferenceFreezeManifest {
  const live = readCanonicalWorkspaceGit();
  const manifest: Omit<InferenceFreezeManifest, "freeze_id"> = {
    schema_version: FREEZE_SCHEMA_VERSION,
    purpose: "official",
    official: true,
    created_at: new Date().toISOString(),
    git: {
      commit: live.commit,
      dirty: false,
      porcelain: "",
    },
    labels: {
      prompt_version: PROMPT_VERSION,
      rule_version: getRuleVersion(),
      corpus_version: getCorpusVersion(),
      output_schema_version: OUTPUT_SCHEMA_VERSION,
    },
    assets: hashFreezeAssets(),
    runtime: {
      ...officialFreezeRuntime(),
      ...observeOfficialProviderBoundary(),
    },
    ...overrides,
  };
  return reseal({
    ...manifest,
    freeze_id: "",
  });
}

function predictionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("prediction-"));
}

function officialModel(provenance = officialSuccessProvenance()): ScriptedReviewModel {
  return new ScriptedReviewModel({
    provider: "deepseek",
    model: OFFICIAL_BENCHMARK_MODEL,
    provenance,
  });
}

function alternateWorkspacePath(): string {
  return tempDir("holdout-other-workspace-");
}

const fakeCleanGit = {
  commit: "c".repeat(40),
  dirty: false,
  porcelain: "",
};

describe("official workspace trust boundary", () => {
  test("Git observation is a non-overridable function bound to an immutable realpath workspace", () => {
    const source = readFileSync(join(workspace, "packages/holdout-protocol/src/git-state.ts"), "utf8");
    const identitySource = readFileSync(join(workspace, "packages/holdout-protocol/src/workspace-identity.ts"), "utf8");
    const rulesSource = readFileSync(join(workspace, "packages/rules-engine/src/rules.ts"), "utf8");
    const corpusSource = readFileSync(join(workspace, "packages/retrieval/src/corpus.ts"), "utf8");
    expect(source).not.toMatch(/export const workspaceGit/);
    expect(source).not.toMatch(/export let /);
    expect(source).not.toMatch(/return process\.cwd\(\)/);
    expect(identitySource).toMatch(/realpathSync/);
    expect(identitySource).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    expect(rulesSource).not.toMatch(/process\.cwd\(\)/);
    expect(corpusSource).not.toMatch(/process\.cwd\(\)/);
    expect(canonicalWorkspaceRoot()).toBe(realpathSync(process.cwd()));
    expect(() => rejectCallerWorkspaceOverride({ repoRoot: "/tmp/other" })).toThrow(
      /cannot be redirected by the caller/,
    );
    expect(() => rejectCallerWorkspaceOverride({ git: fakeCleanGit })).toThrow(
      /cannot be supplied by the caller/,
    );
  });

  test("an isolated process that chdirs after startup cannot obtain official identity", () => {
    const vitestBin = join(workspace, "node_modules", ".bin", "vitest");
    const result = spawnSync(
      vitestBin,
      ["run", "--no-color", "--config", "vitest.chdir.config.mts"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        timeout: 60_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(
      /\u001B\[[0-9;?]*[ -/]*[@-~]/g,
      "",
    );
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Tests\s+1 passed/);
  });

  test("forges a clean Git observation or redirects repoRoot on official create", () => {
    const live = readCanonicalWorkspaceGit();
    expect(() =>
      createInferenceFreeze({
        purpose: "official",
        runtime: officialFreezeRuntime(),
        git: fakeCleanGit,
      } as never),
    ).toThrow(/cannot be supplied by the caller/);
    expect(() =>
      createInferenceFreeze({
        purpose: "official",
        runtime: officialFreezeRuntime(),
        repoRoot: alternateWorkspacePath(),
      } as never),
    ).toThrow(/cannot be redirected by the caller/);
    if (live.dirty) {
      expect(() =>
        createInferenceFreeze({
          purpose: "official",
          runtime: officialFreezeRuntime(),
        }),
      ).toThrow(/dirty/);
    }
  });

  test("rejects official inference and evaluation that use a fake clean git or another checkout", async () => {
    const freeze = synthesizeOfficialFreezeDocument();
    const inputPack = writeExternalLockedInput();
    const artifactDir = tempDir("holdout-redirect-inference-");
    const otherWorkspace = alternateWorkspacePath();

    await expect(
      runOfficialBlindInference({
        freeze,
        inputPack,
        artifactDir,
        git: fakeCleanGit,
      } as never),
    ).rejects.toThrow(/cannot be supplied by the caller/);
    expect(predictionFiles(artifactDir)).toEqual([]);

    await expect(
      runOfficialBlindInference({
        freeze,
        inputPack,
        artifactDir,
        repoRoot: otherWorkspace,
      } as never),
    ).rejects.toThrow(/cannot be redirected by the caller/);
    expect(predictionFiles(artifactDir)).toEqual([]);

    const live = readCanonicalWorkspaceGit();
    if (live.dirty) {
      await expect(
        runOfficialBlindInference({
          freeze,
          runFreeze: { run_freeze_id: "0".repeat(64) } as never,
          inputPack,
          artifactDir: tempDir("holdout-dirty-consume-"),
        }),
      ).rejects.toThrow(/dirty/);
    }

    expect(() =>
      runControlledEvaluation({
        freeze,
        prediction: {
          schema_version: "holdout-prediction.v1",
          prediction_id: "x",
          freeze_id: freeze.freeze_id,
          run_freeze_id: null,
          input_pack_id: "protocol-fixture-v1",
          input_content_sha256: "y",
          role: "protocol_fixture",
          official: true,
          claim: "official_locked",
          created_at: new Date().toISOString(),
          articles: [],
        },
        goldPack: loadGoldPack(join(workspace, "data/benchmark/protocol-fixtures/gold.json")),
        registry: protocolFixtureRegistry(["fixture-01"]),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-fake-clean-eval-"),
        git: fakeCleanGit,
      } as never),
    ).toThrow(/cannot be supplied by the caller/);

    expect(() =>
      runControlledEvaluation({
        freeze,
        prediction: {
          schema_version: "holdout-prediction.v1",
          prediction_id: "x",
          freeze_id: freeze.freeze_id,
          run_freeze_id: null,
          input_pack_id: "protocol-fixture-v1",
          input_content_sha256: "y",
          role: "protocol_fixture",
          official: true,
          claim: "official_locked",
          created_at: new Date().toISOString(),
          articles: [],
        },
        goldPack: loadGoldPack(join(workspace, "data/benchmark/protocol-fixtures/gold.json")),
        registry: protocolFixtureRegistry(["fixture-01"]),
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-redirect-eval-"),
        repoRoot: otherWorkspace,
      } as never),
    ).toThrow(/cannot be redirected by the caller/);
  });

  test("fails closed when freeze commit or assets do not match the actual workspace", () => {
    const driftedCommit = synthesizeOfficialFreezeDocument({
      git: {
        commit: "a".repeat(40),
        dirty: false,
        porcelain: "",
      },
    });
    expect(() => assertOfficialFreezeUsable(driftedCommit)).toThrow(/dirty|drifted/);

    const driftedAsset = synthesizeOfficialFreezeDocument({
      assets: hashFreezeAssets().map((item) =>
        item.path === "packages/benchmark/src/evaluate.ts" ? { ...item, sha256: "0".repeat(64) } : item,
      ),
    });
    expect(() => assertOfficialFreezeUsable(driftedAsset)).toThrow(/dirty|drifted/);
  });
});

describe("official blind inference", () => {
  test("loads a repo-external input-only locked pack without reading gold", () => {
    const inputPack = writeExternalLockedInput();
    expect(inputPack.in_development_repo).toBe(false);
    expect(inputPack.role).toBe("locked");
    const inferenceSource = readFileSync(join(workspace, "packages/holdout-protocol/src/inference.ts"), "utf8");
    expect(inferenceSource).not.toMatch(/gold-pack|loadGoldPack|evaluateReview|loadBenchmarkDataset/);
  });

  test("refuses in-repo locked input and gold-bearing files", () => {
    mkdirSync(join(workspace, ".data"), { recursive: true });
    const inRepo = join(workspace, ".data", "in-repo-locked-input.json");
    writeFileSync(
      inRepo,
      `${JSON.stringify({
        schema_version: "holdout-input.v1",
        pack_id: "in-repo-locked",
        role: "locked",
        articles: [{ article_id: "bad-01", title: "in repo", body: "should be rejected" }],
      })}\n`,
    );
    expect(() => loadInputPack(inRepo)).toThrow(/must not be loaded from the development repo/);
    expect(() => loadInputPack(join(workspace, "data/benchmark/protocol-fixtures/gold.json"))).toThrow(
      /must not contain gold issues/,
    );
  });

  test("rejects a self-hashing official freeze with missing, duplicate, or replaced assets", () => {
    const freeze = synthesizeOfficialFreezeDocument();
    const missing = reseal({
      ...freeze,
      assets: freeze.assets.filter((item) => item.path !== "packages/benchmark/src/evaluate.ts"),
    });
    expect(() => assertOfficialFreezeAssetInventory(missing.assets)).toThrow(
      /missing or has extra inference assets/,
    );
    expect(() => assertOfficialFreezeUsable(missing)).toThrow(
      /missing or has extra inference assets/,
    );

    const duplicate = reseal({
      ...freeze,
      assets: [...freeze.assets, freeze.assets[0]!],
    });
    expect(() => assertOfficialFreezeAssetInventory(duplicate.assets)).toThrow(
      /missing or has extra inference assets|duplicate/,
    );

    const replaced = reseal({
      ...freeze,
      assets: [freeze.assets[1]!, freeze.assets[0]!, ...freeze.assets.slice(2)],
    });
    expect(() => assertOfficialFreezeAssetInventory(replaced.assets)).toThrow(/replaced or reordered/);
  });

  test("rejects official freeze consumption when runtime, dirty bit, or workspace identity is wrong", () => {
    const freeze = synthesizeOfficialFreezeDocument();
    const dirty = reseal({
      ...freeze,
      git: { ...freeze.git, dirty: true, porcelain: " M packages/providers/src/prompt.ts" },
    });
    expect(() => assertOfficialFreezeUsable(dirty)).toThrow(/dirty/);

    const cachedRuntime = officialFreezeRuntime({ application_cache: { enabled: true } });
    expect(() => assertOfficialRuntime(cachedRuntime)).toThrow(/cache/);
    const cached = reseal({
      ...freeze,
      runtime: {
        ...freeze.runtime,
        application_cache: { enabled: true },
      },
    });
    expect(() => assertOfficialFreezeUsable(cached)).toThrow(/cache/);

    const drifted = reseal({
      ...freeze,
      assets: freeze.assets.map((item) =>
        item.path === "packages/benchmark/src/evaluate.ts" ? { ...item, sha256: "0".repeat(64) } : item,
      ),
    });
    expect(() => assertOfficialFreezeUsable(drifted)).toThrow(/dirty|drifted/);
  });

  test("Repair 3 provenance gate remains on the official inference path", async () => {
    const inferenceSource = readFileSync(join(workspace, "packages/holdout-protocol/src/inference.ts"), "utf8");
    expect(inferenceSource).toMatch(/assertOfficialInferenceProvenance/);
    expect(() =>
      assertOfficialInferenceProvenance(
        officialSuccessProvenance([
          officialAttempt({
            attempt: 1,
            outcome: "retryable_failure",
            observed_response_model: null,
            error: "empty",
          }),
          officialAttempt({ attempt: 2 }),
        ]),
      ),
    ).toThrow(/response model was not reported on attempt 1/);
    expect(() =>
      assertOfficialInferenceProvenance(
        officialSuccessProvenance([
          officialAttempt({
            attempt: 1,
            outcome: "retryable_failure",
            observed_response_model: "deepseek-other",
            error: "schema",
          }),
          officialAttempt({ attempt: 2 }),
        ]),
      ),
    ).toThrow(/observed response model deepseek-other/);
    expect(() =>
      assertOfficialInferenceProvenance(
        officialSuccessProvenance([
          officialAttempt({
            received_provider_response: false,
            observed_response_model: null,
            usage: null,
            error: "network",
          }),
        ]),
      ),
    ).toThrow(/no provider response was available to verify the model/);
    expect(() =>
      assertOfficialInferenceProvenance(
        officialSuccessProvenance([
          officialAttempt({
            outcome: "retryable_failure",
            error: "invalid json",
          }),
        ]),
      ),
    ).toThrow(/no provider attempt completed successfully/);
    expect(() =>
      assertOfficialInferenceProvenance(officialSuccessProvenance(), {
        used: true,
      }),
    ).toThrow(/cannot seal a degraded fallback result/);

    const live = readCanonicalWorkspaceGit();
    const freeze = synthesizeOfficialFreezeDocument();
    const artifactDir = tempDir("holdout-official-provenance-");
    const badModel = officialModel(
      officialSuccessProvenance([
        officialAttempt({
          attempt: 1,
          outcome: "retryable_failure",
          observed_response_model: null,
          error: "empty",
        }),
        officialAttempt({ attempt: 2 }),
      ]),
    );
    if (live.dirty) {
      await expect(
        runOfficialBlindInference({
          freeze,
          runFreeze: { run_freeze_id: "0".repeat(64) } as never,
          inputPack: writeExternalLockedInput(),
          model: badModel,
          artifactDir,
        } as never),
      ).rejects.toThrow(/dirty/);
      expect(predictionFiles(artifactDir)).toEqual([]);
      return;
    }

    await withCustodianHomeAsync(async () => {
      const setup = setupOfficialTwoStage({ artifactDir });
      await expect(
        runOfficialBlindInference({
          freeze: setup.systemFreeze,
          runFreeze: setup.runFreeze,
          inputPack: setup.inputPack,
          model: badModel,
          artifactDir,
        } as never),
      ).rejects.toThrow(/caller-supplied ReviewModel/);
      expect(predictionFiles(artifactDir)).toEqual([]);
    });
  });

  test("scripted official locked inference cannot mint an official_locked prediction", async () => {
    const live = readCanonicalWorkspaceGit();
    const inputPack = writeExternalLockedInput();
    const artifactDir = tempDir("holdout-official-run-");
    if (live.dirty) {
      expect(() =>
        createInferenceFreeze({
          purpose: "official",
          runtime: officialFreezeRuntime(),
        }),
      ).toThrow(/dirty/);
      await expect(
        runOfficialBlindInference({
          freeze: synthesizeOfficialFreezeDocument(),
          runFreeze: { run_freeze_id: "0".repeat(64) } as never,
          inputPack,
          model: officialModel(),
          artifactDir,
        } as never),
      ).rejects.toThrow(/dirty/);
      expect(predictionFiles(artifactDir)).toEqual([]);
      return;
    }

    await withCustodianHomeAsync(async () => {
      const setup = setupOfficialTwoStage({ artifactDir });
      await expect(
        runOfficialBlindInference({
          freeze: setup.systemFreeze,
          runFreeze: setup.runFreeze,
          inputPack: setup.inputPack,
          model: officialModel(),
          artifactDir,
        } as never),
      ).rejects.toThrow(/caller-supplied ReviewModel/);
      expect(predictionFiles(artifactDir)).toEqual([]);
    });
  });
});
