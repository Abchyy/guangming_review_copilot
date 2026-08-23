/** @vitest-environment node */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { runControlledEvaluation } from "@grc/holdout-protocol";
import {
  FREEZE_SCHEMA_VERSION,
  createInferenceFreeze,
  freezeIdentity,
  hashFreezeAssets,
  officialFreezeRuntime,
  type InferenceFreezeManifest,
} from "@grc/holdout-protocol";
import {
  canonicalWorkspaceRoot,
  readCanonicalWorkspaceGit,
} from "@grc/holdout-protocol";
import { runOfficialBlindInference } from "@grc/holdout-protocol";
import { loadGoldPack } from "@grc/holdout-protocol";
import { loadInputPack } from "@grc/holdout-protocol";
import { protocolFixtureRegistry } from "@grc/holdout-protocol";
import { OUTPUT_SCHEMA_VERSION, PROMPT_VERSION } from "@grc/providers";
import { getCorpusVersion } from "@grc/retrieval";
import { getRuleVersion } from "@grc/rules-engine";

function reseal(freeze: InferenceFreezeManifest): InferenceFreezeManifest {
  return {
    ...freeze,
    freeze_id: freezeIdentity(freeze),
  };
}

function synthesizeOfficialFreezeDocument(): InferenceFreezeManifest {
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
    runtime: officialFreezeRuntime(),
  };
  return reseal({
    ...manifest,
    freeze_id: "",
  });
}

describe("official cwd drift isolation", () => {
  test("chdir to another checkout cannot retarget official identity", async () => {
    const frozenRoot = canonicalWorkspaceRoot();
    const gitBefore = readCanonicalWorkspaceGit();
    const assetsBefore = hashFreezeAssets();
    const ruleVersion = getRuleVersion();
    const corpusVersion = getCorpusVersion();
    const other = mkdtempSync(join(tmpdir(), "holdout-chdir-clean-"));
    const previousCwd = process.cwd();

    process.chdir(other);
    try {
      expect(canonicalWorkspaceRoot()).toBe(frozenRoot);
      expect(readCanonicalWorkspaceGit()).toEqual(gitBefore);
      expect(hashFreezeAssets()).toEqual(assetsBefore);
      expect(getRuleVersion()).toBe(ruleVersion);
      expect(getCorpusVersion()).toBe(corpusVersion);

      expect(() =>
        createInferenceFreeze({
          purpose: "official",
          runtime: officialFreezeRuntime(),
        }),
      ).toThrow(/process cwd is not the canonical workspace/);

      const freeze = synthesizeOfficialFreezeDocument();
      const inputPath = join(other, "input.json");
      writeFileSync(
        inputPath,
        `${JSON.stringify({
          schema_version: "holdout-input.v1",
          pack_id: "chdir-locked-input",
          role: "locked",
          articles: [{ article_id: "chdir-01", title: "chdir", body: "external input" }],
        })}\n`,
      );
      const inputPack = loadInputPack(inputPath);
      await expect(
        runOfficialBlindInference({
          freeze,
          runFreeze: { run_freeze_id: "0".repeat(64) } as never,
          inputPack,
          artifactDir: other,
        }),
      ).rejects.toThrow(/process cwd is not the canonical workspace/);

      expect(() =>
        runControlledEvaluation({
          freeze,
          prediction: {
            schema_version: "holdout-prediction.v1",
            prediction_id: "x",
            freeze_id: freeze.freeze_id,
            run_freeze_id: null,
            input_pack_id: inputPack.pack_id,
            input_content_sha256: inputPack.content_sha256,
            role: "locked",
            official: true,
            claim: "official_locked",
            created_at: new Date().toISOString(),
            articles: [],
          },
          goldPack: loadGoldPack(join(frozenRoot, "data/benchmark/protocol-fixtures/gold.json")),
          inputPack,
          registry: protocolFixtureRegistry(["chdir-01"]),
          holdoutId: "protocol-fixture-v1",
          artifactDir: other,
        }),
      ).toThrow(/process cwd is not the canonical workspace/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
