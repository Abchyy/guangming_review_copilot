/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runProtocolDryRun } from "@/lib/server/benchmark/holdout/dry-run";
import { runControlledEvaluation } from "@/lib/server/benchmark/holdout/evaluation";
import {
  assertOfficialFreezeUsable,
  createInferenceFreeze,
  createOfficialSystemFreeze,
  freezeIdentity,
  loadPersistedSystemFreeze,
  officialFreezeRuntime,
  persistSystemFreeze,
} from "@/lib/server/benchmark/holdout/freeze";
import { readCanonicalWorkspaceGit } from "@/lib/server/benchmark/holdout/git-state";
import { runOfficialBlindInference } from "@/lib/server/benchmark/holdout/inference";
import { loadGoldPack } from "@/lib/server/benchmark/holdout/gold-pack";
import { loadInputPack } from "@/lib/server/benchmark/holdout/input-pack";
import { HOLDOUT_CUSTODIAN_HOME_ENV } from "@/lib/server/benchmark/holdout/lifecycle";
import {
  assertOfficialRunFreezeUsable,
  createOfficialRunFreeze,
  loadPersistedRunFreeze,
  runFreezeIdentity,
} from "@/lib/server/benchmark/holdout/run-freeze";
import {
  canonicalizeProviderEndpoint,
  observeOfficialAccountBoundaryId,
  observeOfficialProviderBoundary,
  providerAccountBoundaryId,
} from "@/lib/server/benchmark/holdout/provider-identity";
import { DEFAULT_DEEPSEEK_BASE_URL } from "@/lib/server/config";
import { canonicalWorkspaceRoot } from "@/lib/server/workspace-identity";
import { installCanonicalProviderRequestProbe } from "../helpers/canonical-provider-request-probe";
import {
  PROTOCOL_TEST_PROVIDER_KEY,
  applyProtocolProviderEnv,
  setupOfficialTwoStage,
  withCustodianHome,
  withCustodianHomeAsync,
  withProtocolProviderEnv,
  withProtocolProviderEnvAsync,
  writeExternalLockedInput,
} from "../helpers/official-holdout-protocol";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function predictionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("prediction-"));
}

function skipIfDirty(): boolean {
  return readCanonicalWorkspaceGit().dirty;
}

describe("two-stage freeze protocol", () => {
  test("System Freeze persists, reloads, and has a stable self-identity without holdout fields or secrets", () => {
    if (skipIfDirty()) {
      expect(() =>
        withProtocolProviderEnv(() => createOfficialSystemFreeze({ artifactDir: tempDir("holdout-sys-dirty-") })),
      ).toThrow(/dirty/);
      return;
    }

    withProtocolProviderEnv(() => {
      const artifactDir = tempDir("holdout-sys-persist-");
      const freeze = createOfficialSystemFreeze({ artifactDir });
      const reloaded = loadPersistedSystemFreeze(artifactDir, freeze.freeze_id);
      expect(reloaded.freeze_id).toBe(freeze.freeze_id);
      expect(reloaded.freeze_id).toBe(freezeIdentity(reloaded));
      expect(reloaded.runtime.provider_endpoint).toBe(DEFAULT_DEEPSEEK_BASE_URL);
      expect(reloaded.runtime.account_boundary_id).toBe(observeOfficialAccountBoundaryId());
      expect(JSON.stringify(reloaded)).not.toContain(PROTOCOL_TEST_PROVIDER_KEY);
      expect(JSON.stringify(reloaded)).not.toMatch(/holdout_id|article_ids/);
      expect(() => assertOfficialFreezeUsable(reloaded)).not.toThrow();

      const again = createInferenceFreeze({
        purpose: "official",
        runtime: officialFreezeRuntime(),
      });
      expect(again.freeze_id).toBe(freeze.freeze_id);
    });
  });

  test("System Freeze rejects missing credentials, caller-supplied provenance, and later tamper or config change", () => {
    if (skipIfDirty()) {
      expect(() => createOfficialSystemFreeze({ artifactDir: tempDir("holdout-sys-tamper-dirty-") })).toThrow(
        /dirty|DEEPSEEK_API_KEY/,
      );
      return;
    }

    expect(() => createOfficialSystemFreeze({ artifactDir: tempDir("holdout-sys-nokey-") })).toThrow(
      /DEEPSEEK_API_KEY/,
    );

    withProtocolProviderEnv(() => {
      expect(() =>
        createInferenceFreeze({
          purpose: "official",
          runtime: officialFreezeRuntime({
            provider_endpoint: "https://evil.example.com",
            account_boundary_id: "a".repeat(64),
          }),
        }),
      ).toThrow(/cannot be supplied by the caller/);

      const artifactDir = tempDir("holdout-sys-tamper-");
      const freeze = createOfficialSystemFreeze({ artifactDir });
      const filePath = join(artifactDir, `system-freeze-${freeze.freeze_id}.json`);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as typeof freeze;
      parsed.git.commit = "a".repeat(40);
      writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      expect(() => loadPersistedSystemFreeze(artifactDir, freeze.freeze_id)).toThrow(
        /does not match sealed freeze contents/,
      );

      const live = createOfficialSystemFreeze({ artifactDir: tempDir("holdout-sys-change-") });
      process.env.DEEPSEEK_BASE_URL = "https://llm-proxy.example.com";
      try {
        expect(() => assertOfficialFreezeUsable(live)).toThrow(/endpoint/);
      } finally {
        process.env.DEEPSEEK_BASE_URL = DEFAULT_DEEPSEEK_BASE_URL;
      }

      process.env.DEEPSEEK_API_KEY = "sk-test-other-account-not-real";
      try {
        expect(() => assertOfficialFreezeUsable(live)).toThrow(/account boundary/);
      } finally {
        applyProtocolProviderEnv();
      }
    });
  });

  test("provider endpoint and account identity are fail-closed and never persist the credential", () => {
    expect(() => canonicalizeProviderEndpoint("https://user:pass@api.deepseek.com")).toThrow(/embed credentials/);
    expect(() => canonicalizeProviderEndpoint("http://api.deepseek.com")).not.toThrow();
    withProtocolProviderEnv(() => {
      process.env.DEEPSEEK_BASE_URL = "http://api.deepseek.com";
      expect(() => observeOfficialProviderBoundary()).toThrow(/https/);
      applyProtocolProviderEnv();
      const boundary = observeOfficialProviderBoundary();
      expect(boundary.provider_endpoint).toBe("https://api.deepseek.com");
      expect(boundary.account_boundary_id).toBe(
        providerAccountBoundaryId("deepseek", PROTOCOL_TEST_PROVIDER_KEY),
      );
      expect(boundary.account_boundary_id).not.toBe(PROTOCOL_TEST_PROVIDER_KEY);
    });
  });

  test("Run Freeze binds System Freeze, holdout, lifecycle, and custodian identities", () => {
    if (skipIfDirty()) {
      return;
    }

    withProtocolProviderEnv(() => {
      withCustodianHome((home) => {
        const setup = setupOfficialTwoStage();
        const reloaded = loadPersistedRunFreeze(setup.artifactDir, setup.runFreeze.run_freeze_id);
        expect(reloaded.run_freeze_id).toBe(runFreezeIdentity(reloaded));
        expect(reloaded.system_freeze_id).toBe(setup.systemFreeze.freeze_id);
        expect(reloaded.holdout_id).toBe(setup.holdoutId);
        expect(reloaded.input_pack_id).toBe(setup.inputPack.pack_id);
        expect(reloaded.input_content_sha256).toBe(setup.inputPack.content_sha256);
        expect(reloaded.custodian.home).toBe(realpathSync(home));
        expect(reloaded.custodian.lifecycle_path.startsWith(realpathSync(home))).toBe(true);
        expect(reloaded.observed_runtime.provider_endpoint).toBe(setup.systemFreeze.runtime.provider_endpoint);
        expect(reloaded.observed_runtime.account_boundary_id).toBe(setup.systemFreeze.runtime.account_boundary_id);
        expect(JSON.stringify(reloaded)).not.toContain(PROTOCOL_TEST_PROVIDER_KEY);
        expect(() =>
          assertOfficialRunFreezeUsable({
            runFreeze: reloaded,
            systemFreeze: setup.systemFreeze,
            inputPack: setup.inputPack,
            artifactDir: setup.artifactDir,
          }),
        ).not.toThrow();
      });
    });
  });

  test("Run Freeze and official inference reject missing, mismatched, or unclosed identities", async () => {
    if (skipIfDirty()) {
      return;
    }

    await withProtocolProviderEnvAsync(async () => {
      const noCustodianDir = tempDir("holdout-no-custodian-");
      const freezeWithoutCustodian = createOfficialSystemFreeze({ artifactDir: noCustodianDir });
      expect(() =>
        createOfficialRunFreeze({
          artifactDir: noCustodianDir,
          systemFreeze: freezeWithoutCustodian,
          inputPack: writeExternalLockedInput(),
          holdoutId: "synthetic-locked-repair5",
        }),
      ).toThrow(/HOLDOUT_CUSTODIAN_HOME/);

      await withCustodianHomeAsync(async () => {
        const setup = setupOfficialTwoStage();

        await expect(
          runOfficialBlindInference({
            freeze: setup.systemFreeze,
            runFreeze: { run_freeze_id: "0".repeat(64) } as never,
            inputPack: setup.inputPack,
            artifactDir: setup.artifactDir,
          }),
        ).rejects.toThrow(/Run Freeze|does not satisfy/);

        const otherDir = tempDir("holdout-missing-system-");
        persistSystemFreeze(otherDir, setup.systemFreeze);
        await expect(
          runOfficialBlindInference({
            freeze: setup.systemFreeze,
            runFreeze: setup.runFreeze,
            inputPack: setup.inputPack,
            artifactDir: otherDir,
          }),
        ).rejects.toThrow(/missing a persisted Run Freeze/);

        const inMemoryOnly = createInferenceFreeze({
          purpose: "official",
          runtime: officialFreezeRuntime(),
        });
        await expect(
          runOfficialBlindInference({
            freeze: inMemoryOnly,
            runFreeze: setup.runFreeze,
            inputPack: setup.inputPack,
            artifactDir: tempDir("holdout-missing-persist-"),
          }),
        ).rejects.toThrow(/missing a persisted System Freeze/);

        const otherPack = writeExternalLockedInput("other-01");
        expect(() =>
          createOfficialRunFreeze({
            artifactDir: setup.artifactDir,
            systemFreeze: setup.systemFreeze,
            inputPack: otherPack,
            holdoutId: setup.holdoutId,
          }),
        ).toThrow(/article set does not match/);

        expect(() =>
          createOfficialRunFreeze({
            artifactDir: setup.artifactDir,
            systemFreeze: setup.systemFreeze,
            inputPack: setup.inputPack,
            holdoutId: setup.holdoutId,
            lifecyclePath: join(tempDir("holdout-redirect-life-"), "lifecycle.json"),
          } as never),
        ).toThrow(/redirected by the caller/);
      });
    });
  });

  test("fresh-process legal pre-inference path reaches the provider call boundary", async () => {
    if (skipIfDirty()) {
      return;
    }

    const workspace = canonicalWorkspaceRoot();
    const custodianHome = tempDir("holdout-pre-inference-home-");
    const artifactDir = tempDir("holdout-pre-inference-artifacts-");
    const vitestBin = join(workspace, "node_modules", ".bin", "vitest");
    const result = spawnSync(vitestBin, ["run", "--config", "vitest.pre-inference.config.mts"], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        [HOLDOUT_CUSTODIAN_HOME_ENV]: custodianHome,
        DEEPSEEK_API_KEY: PROTOCOL_TEST_PROVIDER_KEY,
        DEEPSEEK_BASE_URL: DEFAULT_DEEPSEEK_BASE_URL,
        HOLDOUT_PROBE_ARTIFACT_DIR: artifactDir,
      },
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Tests\s+1 passed/);
    expect(predictionFiles(artifactDir)).toEqual([]);
    expect(existsSync(join(custodianHome, "holdouts", "synthetic-locked-pre-inference", "lifecycle.json"))).toBe(
      true,
    );
  });

  test("in-process legal path reaches the canonical DeepSeek request boundary before any prediction", async () => {
    if (skipIfDirty()) {
      return;
    }

    await withProtocolProviderEnvAsync(async () => {
      await withCustodianHomeAsync(async () => {
        const setup = setupOfficialTwoStage();
        const probe = installCanonicalProviderRequestProbe();
        try {
          await expect(
            runOfficialBlindInference({
              freeze: setup.systemFreeze,
              runFreeze: setup.runFreeze,
              inputPack: setup.inputPack,
              artifactDir: setup.artifactDir,
            }),
          ).rejects.toThrow(/CANONICAL_PROVIDER_REQUEST_BOUNDARY|DeepSeek provider unavailable/);
          expect(probe.requests.length).toBeGreaterThan(0);
          expect(probe.requests[0]?.origin).toBe(setup.systemFreeze.runtime.provider_endpoint);
          expect(probe.requests[0]?.account_boundary_id).toBe(setup.systemFreeze.runtime.account_boundary_id);
        } finally {
          probe.restore();
        }
        expect(predictionFiles(setup.artifactDir)).toEqual([]);
      });
    });
  });

  test("official inference source verifies Run Freeze before createReview", () => {
    const source = readFileSync(
      join(canonicalWorkspaceRoot(), "src/lib/server/benchmark/holdout/inference.ts"),
      "utf8",
    );
    expect(source.indexOf("assertOfficialRunFreezeUsable")).toBeGreaterThan(0);
    expect(source.indexOf("assertOfficialRunFreezeUsable")).toBeLessThan(source.indexOf("createReview("));
    expect(source.indexOf("createOfficialFrozenDeepSeekModel")).toBeLessThan(source.indexOf("createReview("));
    expect(source.indexOf("loadPersistedSystemFreeze")).toBeLessThan(source.indexOf("createReview("));
    expect(source).not.toMatch(/gold-pack|loadGoldPack|evaluateReview|loadBenchmarkDataset/);
  });

  test("consumed protocol fixture constraints still fail closed after the two-stage repair", async () => {
    const dry = await runProtocolDryRun({ artifactDir: tempDir("holdout-two-stage-regression-") });
    expect(dry.prediction.run_freeze_id).toBeNull();
    expect(dry.result.run_freeze_id).toBeNull();
    expect(() =>
      runControlledEvaluation({
        freeze: dry.freeze,
        prediction: dry.prediction,
        inputPack: loadInputPack(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/input.json")),
        goldPack: loadGoldPack(join(canonicalWorkspaceRoot(), "data/benchmark/protocol-fixtures/gold.json")),
        registry: dry.registry,
        holdoutId: "protocol-fixture-v1",
        artifactDir: tempDir("holdout-two-stage-consumed-"),
        verifyWorkspace: false,
      }),
    ).toThrow(/already consumed|fresh locked/);
  });
});
