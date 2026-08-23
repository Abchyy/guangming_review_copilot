/** @vitest-environment node */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readCanonicalWorkspaceGit } from "@grc/holdout-protocol";
import { runOfficialBlindInference } from "@grc/holdout-protocol";
import { DeepSeekReviewModel } from "@grc/providers";
import { DEFAULT_DEEPSEEK_BASE_URL } from "@grc/providers";
import { canonicalWorkspaceRoot } from "@grc/holdout-protocol";
import { OFFICIAL_BENCHMARK_MODEL } from "@grc/providers";
import {
  CANONICAL_PROVIDER_REQUEST_BOUNDARY,
  installCanonicalProviderRequestProbe,
} from "@grc/test-kit";
import {
  PROTOCOL_TEST_PROVIDER_KEY,
  applyProtocolProviderEnv,
  setupOfficialTwoStage,
  withCustodianHomeAsync,
  withProtocolProviderEnvAsync,
} from "@grc/test-kit";
import { ScriptedReviewModel, officialSuccessProvenance } from "@grc/test-kit";

function predictionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("prediction-"));
}

function skipIfDirty(): boolean {
  return readCanonicalWorkspaceGit().dirty;
}

describe("official provider execution binding", () => {
  test("scripted ReviewModel cannot generate an official_locked prediction", async () => {
    if (skipIfDirty()) {
      return;
    }
    await withProtocolProviderEnvAsync(async () => {
      await withCustodianHomeAsync(async () => {
        const setup = setupOfficialTwoStage();
        await expect(
          runOfficialBlindInference({
            freeze: setup.systemFreeze,
            runFreeze: setup.runFreeze,
            inputPack: setup.inputPack,
            artifactDir: setup.artifactDir,
            model: new ScriptedReviewModel({
              provider: "deepseek",
              model: OFFICIAL_BENCHMARK_MODEL,
              provenance: officialSuccessProvenance(),
            }),
          } as never),
        ).rejects.toThrow(/caller-supplied ReviewModel/);
        expect(predictionFiles(setup.artifactDir)).toEqual([]);
      });
    });
  });

  test("caller-injected DeepSeek client, baseURL, or apiKey cannot be used as official execution", async () => {
    if (skipIfDirty()) {
      return;
    }
    await withProtocolProviderEnvAsync(async () => {
      await withCustodianHomeAsync(async () => {
        const setup = setupOfficialTwoStage();
        const injected = new DeepSeekReviewModel({
          apiKey: "sk-test-other-account-not-real",
          baseURL: "https://llm-proxy.example.com",
          client: {
            chat: {
              completions: {
                create: async () => {
                  throw new Error("injected client must not run");
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
            artifactDir: setup.artifactDir,
            model: injected,
          } as never),
        ).rejects.toThrow(/caller-supplied ReviewModel/);
        expect(predictionFiles(setup.artifactDir)).toEqual([]);
      });
    });
  });

  test("frozen runtime drifting from live endpoint or credential fails closed before a request", async () => {
    if (skipIfDirty()) {
      return;
    }
    await withProtocolProviderEnvAsync(async () => {
      await withCustodianHomeAsync(async () => {
        const setup = setupOfficialTwoStage();
        process.env.DEEPSEEK_BASE_URL = "https://llm-proxy.example.com";
        await expect(
          runOfficialBlindInference({
            freeze: setup.systemFreeze,
            runFreeze: setup.runFreeze,
            inputPack: setup.inputPack,
            artifactDir: setup.artifactDir,
          }),
        ).rejects.toThrow(/endpoint/);
        process.env.DEEPSEEK_BASE_URL = DEFAULT_DEEPSEEK_BASE_URL;
        process.env.DEEPSEEK_API_KEY = "sk-test-other-account-not-real";
        await expect(
          runOfficialBlindInference({
            freeze: setup.systemFreeze,
            runFreeze: setup.runFreeze,
            inputPack: setup.inputPack,
            artifactDir: setup.artifactDir,
          }),
        ).rejects.toThrow(/account boundary/);
        applyProtocolProviderEnv();
        expect(predictionFiles(setup.artifactDir)).toEqual([]);
      });
    });
  });

  test("canonical DeepSeek path reaches the real provider request boundary with frozen endpoint and account", async () => {
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
          ).rejects.toThrow(new RegExp(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY}|DeepSeek provider unavailable`));
          expect(probe.requests.length).toBeGreaterThan(0);
          expect(probe.requests[0]?.origin).toBe(setup.systemFreeze.runtime.provider_endpoint);
          expect(probe.requests[0]?.origin).toBe(DEFAULT_DEEPSEEK_BASE_URL);
          expect(probe.requests[0]?.account_boundary_id).toBe(setup.systemFreeze.runtime.account_boundary_id);
          expect(JSON.stringify(probe.requests)).not.toContain(PROTOCOL_TEST_PROVIDER_KEY);
        } finally {
          probe.restore();
        }
        expect(predictionFiles(setup.artifactDir)).toEqual([]);
      });
    });
  });

  test("official inference constructs a canonical DeepSeek adapter after freeze guards and rejects caller models", () => {
    const source = readFileSync(
      join(canonicalWorkspaceRoot(), "packages/holdout-protocol/src/inference.ts"),
      "utf8",
    );
    expect(source).toMatch(/rejectCallerOfficialProviderInjection/);
    expect(source).toMatch(/createOfficialFrozenDeepSeekModel/);
    expect(source.indexOf("assertOfficialRunFreezeUsable")).toBeLessThan(
      source.indexOf("createOfficialFrozenDeepSeekModel"),
    );
    expect(source.indexOf("createOfficialFrozenDeepSeekModel")).toBeLessThan(source.indexOf("createReview("));
    expect(source).toMatch(/assertOfficialInferenceProvenance/);
    expect(source).not.toMatch(/gold-pack|loadGoldPack|evaluateReview|loadBenchmarkDataset/);
  });

  test("createCanonicalOfficial binds the same endpoint and account used to construct the HTTP client", () => {
    applyProtocolProviderEnv();
    const injectable = new DeepSeekReviewModel({
      apiKey: PROTOCOL_TEST_PROVIDER_KEY,
      client: { chat: { completions: { create: async () => ({}) } } } as never,
    });
    expect(injectable.officialExecution).toBeNull();
    const canonical = DeepSeekReviewModel.createCanonicalOfficial();
    expect(canonical.officialExecution?.provider_endpoint).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    expect(canonical.officialExecution?.requested_model).toBe(OFFICIAL_BENCHMARK_MODEL);
    expect(canonical.officialExecution?.account_boundary_id).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical.model).toBe(OFFICIAL_BENCHMARK_MODEL);
  });
});
