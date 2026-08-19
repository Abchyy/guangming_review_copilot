import { existsSync } from "node:fs";

import { averageMetrics, evaluateReview, type BenchmarkMetrics } from "@/lib/server/benchmark/evaluate";
import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { sealedArtifactPath, writeSealedJson } from "@/lib/server/benchmark/holdout/artifacts";
import {
  assertFreezeIntegrity,
  assertFreezeMatchesWorkspace,
  assertOfficialFreezeUsable,
  type InferenceFreezeManifest,
} from "@/lib/server/benchmark/holdout/freeze";
import { rejectCallerWorkspaceOverride, assertCanonicalProcessCwd } from "@/lib/server/benchmark/holdout/git-state";
import { goldPackContentIdentity, type GoldPack } from "@/lib/server/benchmark/holdout/gold-pack";
import { sha256Canonical, sha256File } from "@/lib/server/benchmark/holdout/identity";
import {
  assertPredictionIntegrity,
  loadSealedPrediction,
  type SealedPrediction,
} from "@/lib/server/benchmark/holdout/inference";
import { inputPackContentIdentity, type InputPack } from "@/lib/server/benchmark/holdout/input-pack";
import {
  assertFreshOfficialHoldout,
  canonicalOfficialLifecyclePath,
  claimHoldoutConsumption,
  completeHoldoutConsumption,
  getHoldoutEntry,
  lifecycleEntryIdentity,
  loadCustodianLifecycle,
  markHoldoutConsumed,
  rejectOfficialLifecycleOverride,
  releaseHoldoutClaim,
  type HoldoutRegistry,
  type HoldoutRegistryEntry,
} from "@/lib/server/benchmark/holdout/lifecycle";
import { assertNotOfficialLockedClaim, claimForRole, type ResultClaim } from "@/lib/server/benchmark/holdout/roles";
import { hashCanonicalArticle } from "@/lib/server/quality/article-hash";

export const RESULT_SCHEMA_VERSION = "holdout-result.v1";

export type HoldoutResultManifest = {
  schema_version: typeof RESULT_SCHEMA_VERSION;
  result_id: string;
  official: boolean;
  claim: ResultClaim;
  freeze_id: string;
  prediction_id: string;
  prediction_artifact_sha256: string;
  input_pack_id: string;
  input_content_sha256: string;
  gold_pack_id: string;
  gold_content_sha256: string;
  evaluator_asset: "src/lib/server/benchmark/evaluate.ts";
  evaluator_sha256: string;
  holdout_id: string;
  holdout_lifecycle_sha256: string;
  dataset_sha256: string;
  article_ids: string[];
  holdout_status_after: "consumed";
  created_at: string;
  metrics: BenchmarkMetrics;
};

export type ControlledEvaluationOptions = {
  freeze: InferenceFreezeManifest;
  prediction: SealedPrediction;
  inputPack: InputPack;
  goldPack: GoldPack;
  registry?: HoldoutRegistry;
  lifecyclePath?: string;
  predictionPath?: string;
  holdoutId: string;
  artifactDir: string;
  createdAt?: string;
  verifyWorkspace?: boolean;
};

export function isOfficialEvaluation(input: {
  freeze: Pick<InferenceFreezeManifest, "official" | "purpose">;
  goldPack: Pick<GoldPack, "role" | "in_development_repo">;
}): boolean {
  return (
    input.freeze.official &&
    claimForRole(input.goldPack.role, input.freeze.purpose) === "official_locked" &&
    !input.goldPack.in_development_repo
  );
}

export function assertResultMatchesConsumedLifecycle(
  result: HoldoutResultManifest,
  entry: HoldoutRegistryEntry,
): void {
  if (entry.holdout_id !== result.holdout_id) {
    throw new HoldoutProtocolError("Persisted lifecycle holdout_id does not match the result manifest");
  }
  if (entry.status !== "consumed") {
    throw new HoldoutProtocolError("Persisted lifecycle is not consumed");
  }
  if (entry.result_id !== result.result_id) {
    throw new HoldoutProtocolError("Persisted lifecycle result_id does not match the result manifest");
  }
  if (lifecycleEntryIdentity(entry) !== result.holdout_lifecycle_sha256) {
    throw new HoldoutProtocolError("Persisted lifecycle identity does not match the result manifest");
  }
}

function resultIdentity(input: Omit<HoldoutResultManifest, "result_id" | "created_at">): string {
  return sha256Canonical(input);
}

export function datasetIdentity(input: {
  holdout_id: string;
  role: InputPack["role"];
  article_ids: string[];
  input_content_sha256: string;
  gold_content_sha256: string;
}): string {
  return sha256Canonical({
    holdout_id: input.holdout_id,
    role: input.role,
    article_ids: [...input.article_ids].sort(),
    input_content_sha256: input.input_content_sha256,
    gold_content_sha256: input.gold_content_sha256,
  });
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

function assertSameArticleSet(label: string, expected: string[], actual: string[]): void {
  if (new Set(actual).size !== actual.length) {
    throw new HoldoutProtocolError(`${label} has duplicate article ids`);
  }
  const left = sortedIds(expected);
  const right = sortedIds(actual);
  if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
    throw new HoldoutProtocolError(`${label} article set does not match the holdout dataset`);
  }
}

function loadVerifiedPrediction(
  options: ControlledEvaluationOptions,
  official: boolean,
): {
  prediction: SealedPrediction;
  predictionArtifactSha256: string;
} {
  const derivedPath = sealedArtifactPath(
    options.artifactDir,
    "prediction",
    options.prediction.prediction_id,
  );
  if (official) {
    if (options.predictionPath != null) {
      throw new HoldoutProtocolError("Official prediction artifact cannot be redirected by the caller");
    }
    if (!existsSync(derivedPath)) {
      throw new HoldoutProtocolError("Official evaluation requires a sealed prediction artifact");
    }
    const prediction = loadSealedPrediction(derivedPath);
    if (prediction.prediction_id !== options.prediction.prediction_id) {
      throw new HoldoutProtocolError("Prediction artifact identity does not match the provided prediction");
    }
    return {
      prediction,
      predictionArtifactSha256: sha256File(derivedPath),
    };
  }
  const predictionPath = options.predictionPath ?? (existsSync(derivedPath) ? derivedPath : null);
  if (predictionPath) {
    const prediction = loadSealedPrediction(predictionPath);
    if (prediction.prediction_id !== options.prediction.prediction_id) {
      throw new HoldoutProtocolError("Prediction artifact identity does not match the provided prediction");
    }
    return {
      prediction,
      predictionArtifactSha256: sha256File(predictionPath),
    };
  }
  const prediction = assertPredictionIntegrity(options.prediction);
  return {
    prediction,
    predictionArtifactSha256: sha256Canonical(prediction),
  };
}

function assertDatasetClosure(input: {
  holdoutId: string;
  registry: HoldoutRegistry;
  inputPack: InputPack;
  goldPack: GoldPack;
  prediction: SealedPrediction;
}): string[] {
  const entry = getHoldoutEntry(input.registry, input.holdoutId);
  if (entry.role !== input.goldPack.role || entry.role !== input.inputPack.role || entry.role !== input.prediction.role) {
    throw new HoldoutProtocolError(
      `Holdout registry role ${entry.role} does not match input/gold/prediction roles`,
    );
  }
  if (input.prediction.input_pack_id !== input.inputPack.pack_id) {
    throw new HoldoutProtocolError(
      `Prediction input pack_id ${input.prediction.input_pack_id} does not match input pack ${input.inputPack.pack_id}`,
    );
  }
  if (input.goldPack.pack_id !== input.inputPack.pack_id) {
    throw new HoldoutProtocolError(
      `Gold pack_id ${input.goldPack.pack_id} does not match input pack ${input.inputPack.pack_id}`,
    );
  }
  const inputIdentity = inputPackContentIdentity(input.inputPack);
  const goldIdentity = goldPackContentIdentity(input.goldPack);
  if (inputIdentity !== input.inputPack.content_sha256) {
    throw new HoldoutProtocolError("Input pack content identity does not match loaded input contents");
  }
  if (goldIdentity !== input.goldPack.content_sha256) {
    throw new HoldoutProtocolError("Gold pack content identity does not match loaded gold contents");
  }
  if (input.prediction.input_content_sha256 !== inputIdentity) {
    throw new HoldoutProtocolError("Prediction input content identity does not match the input pack");
  }

  const articleIds = [...entry.article_ids];
  assertSameArticleSet("input pack", articleIds, input.inputPack.articles.map((item) => item.article_id));
  assertSameArticleSet("gold pack", articleIds, input.goldPack.articles.map((item) => item.article_id));
  assertSameArticleSet("prediction", articleIds, input.prediction.articles.map((item) => item.article_id));

  const inputById = new Map(input.inputPack.articles.map((item) => [item.article_id, item]));
  const goldById = new Map(input.goldPack.articles.map((item) => [item.article_id, item]));
  const predictedById = new Map(input.prediction.articles.map((item) => [item.article_id, item]));
  for (const articleId of articleIds) {
    const source = inputById.get(articleId);
    const gold = goldById.get(articleId);
    const predicted = predictedById.get(articleId);
    if (!source || !gold || !predicted) {
      throw new HoldoutProtocolError(`Holdout dataset is missing article ${articleId}`);
    }
    if (hashCanonicalArticle(source.title, source.body) !== source.input_sha256) {
      throw new HoldoutProtocolError(`Input text does not match input identity for ${articleId}`);
    }
    if (hashCanonicalArticle(gold.title, gold.body) !== gold.input_sha256) {
      throw new HoldoutProtocolError(`Gold text does not match input identity for ${articleId}`);
    }
    if (hashCanonicalArticle(predicted.title, predicted.body) !== predicted.input_sha256) {
      throw new HoldoutProtocolError(`Prediction text does not match input identity for ${articleId}`);
    }
    if (source.input_sha256 !== gold.input_sha256 || gold.input_sha256 !== predicted.input_sha256) {
      throw new HoldoutProtocolError(`Input identity mismatch for ${articleId}`);
    }
  }
  return articleIds;
}

export function runControlledEvaluation(options: ControlledEvaluationOptions): {
  result: HoldoutResultManifest;
  registry: HoldoutRegistry;
} {
  rejectCallerWorkspaceOverride(options);
  const official = isOfficialEvaluation({ freeze: options.freeze, goldPack: options.goldPack });
  if (official) {
    rejectOfficialLifecycleOverride(options);
  }
  if (official || options.freeze.official || options.prediction.official || options.prediction.claim === "official_locked") {
    assertCanonicalProcessCwd();
  }
  if (options.freeze.official && options.verifyWorkspace === false) {
    throw new HoldoutProtocolError("Official freeze consumption cannot skip workspace verification");
  }

  const { prediction, predictionArtifactSha256 } = loadVerifiedPrediction(options, official);

  const officialLifecyclePath = official ? canonicalOfficialLifecyclePath(options.holdoutId) : options.lifecyclePath;
  if (official) {
    if (!officialLifecyclePath || !existsSync(officialLifecyclePath)) {
      throw new HoldoutProtocolError("Official holdout lifecycle was not found at the unique custodian path");
    }
    const custodian = loadCustodianLifecycle(officialLifecyclePath);
    const current = getHoldoutEntry(custodian, options.holdoutId);
    if (current.status !== "available") {
      throw new HoldoutProtocolError(
        `Holdout ${options.holdoutId} is ${current.status} and cannot be used as fresh locked generalization evidence`,
      );
    }
  }

  const freeze = options.freeze.official
    ? assertOfficialFreezeUsable(options.freeze)
    : assertFreezeIntegrity(options.freeze);
  if (!freeze.official && options.verifyWorkspace !== false) {
    assertFreezeMatchesWorkspace(freeze);
  }

  if (prediction.freeze_id !== freeze.freeze_id) {
    throw new HoldoutProtocolError(
      `Prediction freeze_id ${prediction.freeze_id} does not match freeze ${freeze.freeze_id}`,
    );
  }
  if (prediction.role !== options.goldPack.role) {
    throw new HoldoutProtocolError(
      `Gold role ${options.goldPack.role} does not match prediction role ${prediction.role}`,
    );
  }

  const claim = claimForRole(options.goldPack.role, freeze.purpose);
  if (official) {
    if (claim !== "official_locked") {
      throw new HoldoutProtocolError("Official locked evaluation preconditions were not met");
    }
  } else if (options.freeze.official && claim === "official_locked") {
    throw new HoldoutProtocolError("Official locked evaluation preconditions were not met");
  }

  let registry = officialLifecyclePath
    ? loadCustodianLifecycle(officialLifecyclePath)
    : options.registry;
  if (!registry) {
    throw new HoldoutProtocolError("Evaluation requires a holdout registry or custodian lifecycle file");
  }

  const articleIds = assertDatasetClosure({
    holdoutId: options.holdoutId,
    registry,
    inputPack: options.inputPack,
    goldPack: options.goldPack,
    prediction,
  });
  const entry = getHoldoutEntry(registry, options.holdoutId);
  if (official) {
    assertFreshOfficialHoldout(entry);
  } else {
    assertNotOfficialLockedClaim({ official: false, claim, role: options.goldPack.role });
    if (claim === "official_locked") {
      throw new HoldoutProtocolError("Official locked evaluation preconditions were not met");
    }
    if (entry.status === "consumed") {
      throw new HoldoutProtocolError(
        `Holdout ${options.holdoutId} is already consumed and cannot be evaluated again as a fresh locked set`,
      );
    }
  }

  const evaluator = freeze.assets.find((item) => item.path === "src/lib/server/benchmark/evaluate.ts");
  if (!evaluator) {
    throw new HoldoutProtocolError("Freeze is missing evaluator asset identity");
  }

  let claimed = false;
  let resultWritten = false;
  try {
    if (officialLifecyclePath) {
      registry = claimHoldoutConsumption(officialLifecyclePath, options.holdoutId);
      claimed = true;
    }

    const goldById = new Map(options.goldPack.articles.map((item) => [item.article_id, item]));
    const rows: BenchmarkMetrics[] = [];
    for (const articleId of articleIds) {
      const predicted = prediction.articles.find((item) => item.article_id === articleId);
      const gold = goldById.get(articleId);
      if (!predicted || !gold) {
        throw new HoldoutProtocolError(`Gold missing article ${articleId}`);
      }
      const evaluated = evaluateReview(
        { title: predicted.title, body: predicted.body, version: 1 },
        predicted.findings,
        gold.issues,
      );
      rows.push({
        ...evaluated.metrics,
        latency_ms: predicted.runtime.latency_ms,
        cost_usd: predicted.runtime.cost_usd,
      });
    }

    const datasetSha256 = datasetIdentity({
      holdout_id: options.holdoutId,
      role: options.inputPack.role,
      article_ids: articleIds,
      input_content_sha256: options.inputPack.content_sha256,
      gold_content_sha256: options.goldPack.content_sha256,
    });
    const pendingEntry = getHoldoutEntry(registry, options.holdoutId);
    const body: Omit<HoldoutResultManifest, "result_id" | "created_at"> = {
      schema_version: RESULT_SCHEMA_VERSION,
      official,
      claim,
      freeze_id: freeze.freeze_id,
      prediction_id: prediction.prediction_id,
      prediction_artifact_sha256: predictionArtifactSha256,
      input_pack_id: prediction.input_pack_id,
      input_content_sha256: options.inputPack.content_sha256,
      gold_pack_id: options.goldPack.pack_id,
      gold_content_sha256: options.goldPack.content_sha256,
      evaluator_asset: "src/lib/server/benchmark/evaluate.ts",
      evaluator_sha256: evaluator.sha256,
      holdout_id: options.holdoutId,
      holdout_lifecycle_sha256: lifecycleEntryIdentity(pendingEntry),
      dataset_sha256: datasetSha256,
      article_ids: sortedIds(articleIds),
      holdout_status_after: "consumed",
      metrics: averageMetrics(rows),
    };
    const result: HoldoutResultManifest = {
      ...body,
      result_id: resultIdentity(body),
      created_at: options.createdAt ?? new Date().toISOString(),
    };

    writeSealedJson(sealedArtifactPath(options.artifactDir, "result", result.result_id), result);
    resultWritten = true;

    const persisted = officialLifecyclePath
      ? completeHoldoutConsumption(officialLifecyclePath, options.holdoutId, result.result_id)
      : markHoldoutConsumed(registry, options.holdoutId, result.result_id);
    assertResultMatchesConsumedLifecycle(result, getHoldoutEntry(persisted, options.holdoutId));
    return { result, registry: persisted };
  } catch (error) {
    if (claimed && !resultWritten && officialLifecyclePath) {
      releaseHoldoutClaim(officialLifecyclePath, options.holdoutId);
    }
    throw error;
  }
}
