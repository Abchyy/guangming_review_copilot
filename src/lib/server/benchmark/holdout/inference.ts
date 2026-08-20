import type { Finding, ReviewExecutionProvenance } from "@/lib/contracts/review";
import { findingSchema } from "@/lib/contracts/review";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { HoldoutProtocolError, protocolErrorFrom } from "@/lib/server/benchmark/holdout/errors";
import { sealedArtifactPath, writeSealedJson } from "@/lib/server/benchmark/holdout/artifacts";
import {
  assertFreezeIntegrity,
  assertFreezeMatchesWorkspace,
  assertOfficialFreezeUsable,
  loadPersistedSystemFreeze,
  type InferenceFreezeManifest,
} from "@/lib/server/benchmark/holdout/freeze";
import { rejectCallerWorkspaceOverride, assertCanonicalProcessCwd } from "@/lib/server/benchmark/holdout/git-state";
import { sha256Canonical } from "@/lib/server/benchmark/holdout/identity";
import type { InputPack } from "@/lib/server/benchmark/holdout/input-pack";
import { claimForRole, type ResultClaim } from "@/lib/server/benchmark/holdout/roles";
import {
  assertOfficialRunFreezeUsable,
  type RunFreezeManifest,
} from "@/lib/server/benchmark/holdout/run-freeze";
import { snapshotFromProvenance, type CallRuntimeSnapshot } from "@/lib/server/benchmark/runtime-report";
import { assertOfficialBenchmarkProvenance } from "@/lib/server/llm/provenance";
import type { ReviewModel } from "@/lib/server/llm/review-model";
import { createReview } from "@/lib/server/review-service";

export const PREDICTION_SCHEMA_VERSION = "holdout-prediction.v1";

export type SealedPredictionArticle = {
  article_id: string;
  input_sha256: string;
  title: string;
  body: string;
  findings: Finding[];
  provenance: ReviewExecutionProvenance;
  runtime: CallRuntimeSnapshot;
};

export type SealedPrediction = {
  schema_version: typeof PREDICTION_SCHEMA_VERSION;
  prediction_id: string;
  freeze_id: string;
  run_freeze_id: string | null;
  input_pack_id: string;
  input_content_sha256: string;
  role: InputPack["role"];
  official: boolean;
  claim: ResultClaim;
  created_at: string;
  articles: SealedPredictionArticle[];
};

export type BlindInferenceOptions = {
  freeze: InferenceFreezeManifest;
  runFreeze?: RunFreezeManifest;
  inputPack: InputPack;
  model: ReviewModel;
  artifactDir: string;
  createdAt?: string;
  verifyWorkspace?: boolean;
};

export function predictionIdentity(input: {
  freeze_id: string;
  run_freeze_id: string | null;
  input_pack_id: string;
  input_content_sha256: string;
  role: SealedPrediction["role"];
  official: boolean;
  claim: ResultClaim;
  articles: Array<{
    article_id: string;
    input_sha256: string;
    title: string;
    body: string;
    findings: Finding[];
  }>;
}): string {
  return sha256Canonical({
    freeze_id: input.freeze_id,
    run_freeze_id: input.run_freeze_id,
    input_pack_id: input.input_pack_id,
    input_content_sha256: input.input_content_sha256,
    role: input.role,
    official: input.official,
    claim: input.claim,
    articles: input.articles.map((item) => ({
      article_id: item.article_id,
      input_sha256: item.input_sha256,
      title: item.title,
      body: item.body,
      findings: item.findings,
    })),
  });
}

const sealedPredictionSchema = z.object({
  schema_version: z.literal(PREDICTION_SCHEMA_VERSION),
  prediction_id: z.string().regex(/^[0-9a-f]{64}$/),
  freeze_id: z.string().min(1),
  run_freeze_id: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.null()]),
  input_pack_id: z.string().min(1),
  input_content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.enum(["dev", "regression", "locked", "protocol_fixture"]),
  official: z.boolean(),
  claim: z.enum(["protocol_dry_run", "dev_diagnostic", "regression_contaminated", "official_locked"]),
  created_at: z.string().min(1),
  articles: z
    .array(
      z.object({
        article_id: z.string().min(1),
        input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        title: z.string(),
        body: z.string(),
        findings: z.array(findingSchema),
        provenance: z.unknown(),
        runtime: z.unknown(),
      }),
    )
    .min(1),
});

export function assertPredictionIntegrity(raw: unknown): SealedPrediction {
  const parsed = sealedPredictionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HoldoutProtocolError("Prediction artifact does not satisfy the sealed prediction contract");
  }
  const expected = predictionIdentity(parsed.data);
  if (parsed.data.prediction_id !== expected) {
    throw new HoldoutProtocolError("Prediction identity does not match sealed prediction contents");
  }
  return parsed.data as SealedPrediction;
}

export function loadSealedPrediction(filePath: string): SealedPrediction {
  return assertPredictionIntegrity(JSON.parse(readFileSync(filePath, "utf8")));
}

function assertOfficialLockedInput(inputPack: InputPack, freeze: InferenceFreezeManifest): void {
  if (freeze.purpose !== "official" || !freeze.official) {
    throw new HoldoutProtocolError("Locked input requires an official inference freeze");
  }
  if (inputPack.role !== "locked") {
    throw new HoldoutProtocolError(
      `Official freeze cannot run against role ${inputPack.role}. Official locked input must be a hidden external pack.`,
    );
  }
  if (inputPack.in_development_repo) {
    throw new HoldoutProtocolError(
      "Official locked input must not be loaded from the development repo",
    );
  }
}

export function assertOfficialInferenceProvenance(provenance: ReviewExecutionProvenance): void {
  try {
    assertOfficialBenchmarkProvenance(provenance);
  } catch (error) {
    throw protocolErrorFrom(error, "Official runtime provenance does not satisfy the benchmark gate");
  }
  if (provenance.application_cache.enabled || provenance.application_cache.hit) {
    throw new HoldoutProtocolError("Official locked inference cannot use application cache");
  }
}

export async function runOfficialBlindInference(
  options: Omit<BlindInferenceOptions, "verifyWorkspace"> & { runFreeze: RunFreezeManifest },
): Promise<SealedPrediction> {
  rejectCallerWorkspaceOverride(options);
  assertCanonicalProcessCwd();
  return runBlindInference({
    ...options,
    verifyWorkspace: true,
  });
}

export async function runBlindInference(options: BlindInferenceOptions): Promise<SealedPrediction> {
  rejectCallerWorkspaceOverride(options);
  const officialPath = options.freeze.official || options.inputPack.role === "locked";
  if (officialPath) {
    assertCanonicalProcessCwd();
    if (options.verifyWorkspace === false) {
      throw new HoldoutProtocolError("Official freeze consumption cannot skip workspace verification");
    }
  }
  let boundRunFreeze: RunFreezeManifest | null = null;
  const freeze = officialPath
    ? (() => {
        const usable = assertOfficialFreezeUsable(options.freeze);
        if (!options.runFreeze) {
          throw new HoldoutProtocolError("Official inference is missing a Run Freeze");
        }
        const persisted = loadPersistedSystemFreeze(options.artifactDir, usable.freeze_id);
        if (persisted.freeze_id !== usable.freeze_id) {
          throw new HoldoutProtocolError("System Freeze identity does not match the persisted System Freeze");
        }
        boundRunFreeze = assertOfficialRunFreezeUsable({
          runFreeze: options.runFreeze,
          systemFreeze: usable,
          inputPack: options.inputPack,
          artifactDir: options.artifactDir,
        });
        return usable;
      })()
    : assertFreezeIntegrity(options.freeze);

  if (officialPath) {
    assertOfficialLockedInput(options.inputPack, freeze);
  } else if (options.verifyWorkspace !== false) {
    assertFreezeMatchesWorkspace(freeze);
  }

  if (options.model.provider !== freeze.runtime.adapter_provider) {
    throw new HoldoutProtocolError(
      `Inference provider ${options.model.provider} does not match freeze ${freeze.runtime.adapter_provider}`,
    );
  }
  if (options.model.model !== freeze.runtime.requested_model) {
    throw new HoldoutProtocolError(
      `Requested model ${options.model.model} does not match freeze ${freeze.runtime.requested_model}`,
    );
  }

  const articles: SealedPredictionArticle[] = [];
  for (const article of options.inputPack.articles) {
    const snapshot = await createReview(
      { title: article.title, body: article.body },
      options.model,
      {
        promptMode: freeze.runtime.prompt_mode,
        useCache: freeze.runtime.application_cache.enabled,
      },
    );
    const provenance = snapshot.pipeline.provenance;
    if (!provenance) {
      throw new HoldoutProtocolError(`Missing execution provenance for ${article.article_id}`);
    }
    if (officialPath) {
      assertOfficialInferenceProvenance(provenance);
    }
    articles.push({
      article_id: article.article_id,
      input_sha256: article.input_sha256,
      title: article.title,
      body: article.body,
      findings: snapshot.findings,
      provenance,
      runtime: snapshotFromProvenance(provenance),
    });
  }

  const claim = claimForRole(options.inputPack.role, freeze.purpose);
  const official = officialPath && claim === "official_locked";
  if (officialPath && !official) {
    throw new HoldoutProtocolError("Official locked inference did not produce an official_locked claim");
  }
  if (official) {
    if (!boundRunFreeze) {
      throw new HoldoutProtocolError("Official inference is missing a Run Freeze");
    }
    if (boundRunFreeze.system_freeze_id !== freeze.freeze_id) {
      throw new HoldoutProtocolError("System Freeze identity does not match Run Freeze");
    }
  }
  const runFreezeId = official && boundRunFreeze ? boundRunFreeze.run_freeze_id : null;
  const body: Omit<SealedPrediction, "prediction_id" | "created_at"> = {
    schema_version: PREDICTION_SCHEMA_VERSION,
    freeze_id: freeze.freeze_id,
    run_freeze_id: runFreezeId,
    input_pack_id: options.inputPack.pack_id,
    input_content_sha256: options.inputPack.content_sha256,
    role: options.inputPack.role,
    official,
    claim,
    articles,
  };
  const prediction: SealedPrediction = {
    ...body,
    prediction_id: predictionIdentity(body),
    created_at: options.createdAt ?? new Date().toISOString(),
  };

  if (!officialPath) {
    writeSealedJson(sealedArtifactPath(options.artifactDir, "freeze", freeze.freeze_id), freeze);
  }
  writeSealedJson(sealedArtifactPath(options.artifactDir, "prediction", prediction.prediction_id), prediction);
  return prediction;
}
