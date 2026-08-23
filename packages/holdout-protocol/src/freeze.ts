import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { readJsonFile, sealedArtifactPath, writeSealedJson } from "./artifacts";
import { HoldoutProtocolError } from "./errors";
import { sha256Canonical, sha256FileAt } from "./identity";
import { canonicalWorkspaceRoot, readCanonicalWorkspaceGit, rejectCallerWorkspaceOverride, assertCanonicalProcessCwd, type GitSnapshot } from "./git-state";
import {
  assertArtifactContainsNoSecrets,
  observeOfficialProviderBoundary,
} from "./provider-identity";
import {
  OFFICIAL_BENCHMARK_MODEL,
  OFFICIAL_BENCHMARK_PROVIDER,
} from "@grc/providers";
import { DEEPSEEK_RETRY_POLICY } from "@grc/providers";
import { OUTPUT_SCHEMA_VERSION, PROMPT_VERSION } from "@grc/providers";
import { getCorpusVersion } from "@grc/retrieval";
import { getRuleVersion } from "@grc/rules-engine";
import { getDeepSeekApiKey } from "@grc/providers";
import type { ReviewProvider } from "@grc/contracts";
import type { FreezePurpose } from "./roles";

export const FREEZE_SCHEMA_VERSION = "holdout-freeze.v1";

export const FREEZE_ASSET_PATHS = [
  "packages/contracts/src/index.ts",
  "packages/providers/src/prompt.ts",
  "packages/contracts/src/review.ts",
  "packages/contracts/src/specialists.ts",
  "data/rules/catalog.json",
  "data/corpus/references.json",
  "packages/benchmark/src/index.ts",
  "packages/benchmark/src/dataset.ts",
  "packages/benchmark/src/evaluate.ts",
  "packages/benchmark/src/runtime-report.ts",
  "packages/benchmark/src/workspace-root.ts",
  "packages/rules-engine/src/index.ts",
  "packages/rules-engine/src/article-text.ts",
  "packages/rules-engine/src/rules.ts",
  "packages/rules-engine/src/versions.ts",
  "packages/rules-engine/src/workspace-root.ts",
  "packages/retrieval/src/index.ts",
  "packages/retrieval/src/retrieval.ts",
  "packages/retrieval/src/versions.ts",
  "packages/retrieval/src/workspace-root.ts",
  "packages/review-core/src/index.ts",
  "packages/review-core/src/article-hash.ts",
  "packages/review-core/src/fusion.ts",
  "packages/review-core/src/normalization.ts",
  "packages/review-core/src/ranking.ts",
  "packages/review-core/src/finding-rank.ts",
  "packages/review-core/src/evidence.ts",
  "packages/review-core/src/severity.ts",
  "packages/retrieval/src/corpus.ts",
  "packages/review-core/src/versions.ts",
  "packages/review-core/src/span-locator.ts",
  "packages/review-core/src/pipeline.ts",
  "packages/providers/src/index.ts",
  "packages/providers/src/candidate-cache.ts",
  "packages/providers/src/create-review-model.ts",
  "packages/providers/src/deepseek-pricing.ts",
  "packages/providers/src/deepseek-review-model.ts",
  "packages/providers/src/fixture-review-model.ts",
  "packages/providers/src/official-endpoint.ts",
  "packages/providers/src/openai-review-model.ts",
  "packages/providers/src/config.ts",
  "packages/providers/src/provenance.ts",
  "packages/providers/src/review-model.ts",
  "packages/providers/src/workspace-root.ts",
  "package-lock.json",
] as const;

export type FreezeAssetPath = (typeof FREEZE_ASSET_PATHS)[number];

export type FreezeAssetIdentity = {
  path: FreezeAssetPath;
  sha256: string;
};

export type FreezeRuntimeConfig = {
  adapter_provider: ReviewProvider;
  requested_model: string | null;
  prompt_mode: "baseline" | "copilot";
  application_cache: { enabled: boolean };
  retry: {
    max_attempts: number;
    timeout_ms: number | null;
    max_tokens: number | null;
  };
  provider_endpoint: string | null;
  account_boundary_id: string | null;
};

export type InferenceFreezeManifest = {
  schema_version: typeof FREEZE_SCHEMA_VERSION;
  freeze_id: string;
  purpose: FreezePurpose;
  official: boolean;
  created_at: string;
  git: GitSnapshot;
  labels: {
    prompt_version: string;
    rule_version: string;
    corpus_version: string;
    output_schema_version: string;
  };
  assets: FreezeAssetIdentity[];
  runtime: FreezeRuntimeConfig;
};

export type SystemFreezeManifest = InferenceFreezeManifest;

export type CreateFreezeOptions = {
  purpose: FreezePurpose;
  runtime: FreezeRuntimeConfig;
  createdAt?: string;
};

function defaultOfficialRuntime(): FreezeRuntimeConfig {
  return {
    adapter_provider: OFFICIAL_BENCHMARK_PROVIDER,
    requested_model: OFFICIAL_BENCHMARK_MODEL,
    prompt_mode: "copilot",
    application_cache: { enabled: false },
    retry: {
      max_attempts: DEEPSEEK_RETRY_POLICY.max_attempts,
      timeout_ms: DEEPSEEK_RETRY_POLICY.timeout_ms,
      max_tokens: DEEPSEEK_RETRY_POLICY.max_tokens,
    },
    provider_endpoint: null,
    account_boundary_id: null,
  };
}

export function officialFreezeRuntime(
  overrides: Partial<FreezeRuntimeConfig> = {},
): FreezeRuntimeConfig {
  return {
    ...defaultOfficialRuntime(),
    ...overrides,
    application_cache: overrides.application_cache ?? { enabled: false },
    retry: {
      ...defaultOfficialRuntime().retry,
      ...overrides.retry,
    },
  };
}

export function hashFreezeAssets(): FreezeAssetIdentity[] {
  const workspaceRoot = canonicalWorkspaceRoot();
  return FREEZE_ASSET_PATHS.map((assetPath) => {
    const absolute = join(workspaceRoot, assetPath);
    if (!existsSync(absolute)) {
      throw new HoldoutProtocolError(`Refusing freeze: missing asset ${assetPath}`);
    }
    return { path: assetPath, sha256: sha256FileAt(workspaceRoot, assetPath) };
  });
}

function freezeBody(input: Omit<InferenceFreezeManifest, "freeze_id">): unknown {
  return {
    schema_version: input.schema_version,
    purpose: input.purpose,
    official: input.official,
    git: {
      commit: input.git.commit,
      dirty: input.git.dirty,
    },
    labels: input.labels,
    assets: input.assets,
    runtime: input.runtime,
  };
}

export function freezeIdentity(input: Omit<InferenceFreezeManifest, "freeze_id">): string {
  return sha256Canonical(freezeBody(input));
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/i);

const freezeAssetSchema = z.object({
  path: z.enum(FREEZE_ASSET_PATHS),
  sha256: sha256Schema,
});

const freezeManifestSchema = z.object({
  schema_version: z.literal(FREEZE_SCHEMA_VERSION),
  freeze_id: sha256Schema,
  purpose: z.enum(["official", "protocol_dry_run"]),
  official: z.boolean(),
  created_at: z.string().min(1),
  git: z.object({
    commit: gitCommitSchema,
    dirty: z.boolean(),
    porcelain: z.string(),
  }),
  labels: z.object({
    prompt_version: z.string().min(1),
    rule_version: z.string().min(1),
    corpus_version: z.string().min(1),
    output_schema_version: z.string().min(1),
  }),
  assets: z.array(freezeAssetSchema).min(1),
  runtime: z.object({
    adapter_provider: z.enum(["fixture", "deepseek", "openai"]),
    requested_model: z.string().nullable(),
    prompt_mode: z.enum(["baseline", "copilot"]),
    application_cache: z.object({
      enabled: z.boolean(),
    }),
    retry: z.object({
      max_attempts: z.number().int().positive(),
      timeout_ms: z.number().int().positive().nullable(),
      max_tokens: z.number().int().positive().nullable(),
    }),
    provider_endpoint: z.string().min(1).nullable(),
    account_boundary_id: z.union([sha256Schema, z.null()]),
  }),
});

export function parseFreezeManifest(raw: unknown): InferenceFreezeManifest {
  const parsed = freezeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HoldoutProtocolError("Freeze manifest does not satisfy the inference freeze contract");
  }
  return parsed.data;
}

export function assertOfficialRuntimePolicy(runtime: FreezeRuntimeConfig): void {
  if (runtime.adapter_provider !== OFFICIAL_BENCHMARK_PROVIDER) {
    throw new HoldoutProtocolError(
      `Refusing official freeze: adapter provider ${runtime.adapter_provider} !== ${OFFICIAL_BENCHMARK_PROVIDER}`,
    );
  }
  if (runtime.requested_model !== OFFICIAL_BENCHMARK_MODEL) {
    throw new HoldoutProtocolError(
      `Refusing official freeze: requested model ${runtime.requested_model} !== ${OFFICIAL_BENCHMARK_MODEL}`,
    );
  }
  if (runtime.prompt_mode !== "copilot") {
    throw new HoldoutProtocolError("Refusing official freeze: prompt_mode must be copilot");
  }
  if (runtime.application_cache.enabled) {
    throw new HoldoutProtocolError("Refusing official freeze: application cache must be disabled");
  }
  if (runtime.retry.max_attempts !== DEEPSEEK_RETRY_POLICY.max_attempts) {
    throw new HoldoutProtocolError(
      `Refusing official freeze: retry max_attempts ${runtime.retry.max_attempts} !== ${DEEPSEEK_RETRY_POLICY.max_attempts}`,
    );
  }
  if (runtime.retry.timeout_ms !== DEEPSEEK_RETRY_POLICY.timeout_ms) {
    throw new HoldoutProtocolError(
      `Refusing official freeze: retry timeout_ms ${runtime.retry.timeout_ms} !== ${DEEPSEEK_RETRY_POLICY.timeout_ms}`,
    );
  }
  if (runtime.retry.max_tokens !== DEEPSEEK_RETRY_POLICY.max_tokens) {
    throw new HoldoutProtocolError(
      `Refusing official freeze: retry max_tokens ${runtime.retry.max_tokens} !== ${DEEPSEEK_RETRY_POLICY.max_tokens}`,
    );
  }
}

export function assertOfficialProviderBoundary(runtime: FreezeRuntimeConfig): void {
  if (runtime.provider_endpoint == null || runtime.provider_endpoint.length === 0) {
    throw new HoldoutProtocolError("Official freeze is missing provider endpoint identity");
  }
  if (runtime.account_boundary_id == null || !/^[0-9a-f]{64}$/.test(runtime.account_boundary_id)) {
    throw new HoldoutProtocolError("Official freeze is missing provider account boundary identity");
  }
  const live = observeOfficialProviderBoundary();
  if (runtime.provider_endpoint !== live.provider_endpoint) {
    throw new HoldoutProtocolError(
      `Official provider endpoint drifted: live ${live.provider_endpoint} !== freeze ${runtime.provider_endpoint}`,
    );
  }
  if (runtime.account_boundary_id !== live.account_boundary_id) {
    throw new HoldoutProtocolError("Official provider account boundary identity does not match the live credential");
  }
}

export function assertOfficialRuntime(runtime: FreezeRuntimeConfig): void {
  assertOfficialRuntimePolicy(runtime);
  assertOfficialProviderBoundary(runtime);
}

function rejectCallerProviderBoundaryOverride(runtime: FreezeRuntimeConfig): void {
  if (runtime.provider_endpoint != null || runtime.account_boundary_id != null) {
    throw new HoldoutProtocolError(
      "Official provider endpoint/account identity cannot be supplied by the caller",
    );
  }
}

function normalizeRuntime(runtime: FreezeRuntimeConfig): FreezeRuntimeConfig {
  return {
    ...runtime,
    provider_endpoint: runtime.provider_endpoint ?? null,
    account_boundary_id: runtime.account_boundary_id ?? null,
  };
}

export function assertOfficialFreezeAssetInventory(assets: FreezeAssetIdentity[]): void {
  if (assets.length !== FREEZE_ASSET_PATHS.length) {
    throw new HoldoutProtocolError(
      `Official freeze is missing or has extra inference assets: expected ${FREEZE_ASSET_PATHS.length}, got ${assets.length}`,
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < FREEZE_ASSET_PATHS.length; index += 1) {
    const expected = FREEZE_ASSET_PATHS[index]!;
    const asset = assets[index];
    if (!asset) {
      throw new HoldoutProtocolError(`Official freeze is missing inference asset ${expected}`);
    }
    if (seen.has(asset.path)) {
      throw new HoldoutProtocolError(`Official freeze has duplicate inference asset ${asset.path}`);
    }
    seen.add(asset.path);
    if (asset.path !== expected) {
      throw new HoldoutProtocolError(
        `Official freeze asset replaced or reordered: expected ${expected}, got ${asset.path}`,
      );
    }
  }
}

function assertOfficialFreezeLabels(freeze: InferenceFreezeManifest): void {
  if (freeze.labels.prompt_version !== PROMPT_VERSION) {
    throw new HoldoutProtocolError("Official freeze prompt_version does not match the frozen workspace");
  }
  if (freeze.labels.rule_version !== getRuleVersion()) {
    throw new HoldoutProtocolError("Official freeze rule_version does not match the frozen workspace");
  }
  if (freeze.labels.corpus_version !== getCorpusVersion()) {
    throw new HoldoutProtocolError("Official freeze corpus_version does not match the frozen workspace");
  }
  if (freeze.labels.output_schema_version !== OUTPUT_SCHEMA_VERSION) {
    throw new HoldoutProtocolError("Official freeze output_schema_version does not match the frozen workspace");
  }
}

export function createInferenceFreeze(options: CreateFreezeOptions): InferenceFreezeManifest {
  rejectCallerWorkspaceOverride(options);
  if (options.purpose === "official") {
    assertCanonicalProcessCwd();
  }
  const git = readCanonicalWorkspaceGit();
  const purpose = options.purpose;
  const official = purpose === "official";
  let runtime = normalizeRuntime(options.runtime);

  if (official) {
    if (git.dirty) {
      throw new HoldoutProtocolError(
        "Refusing official inference freeze: working tree is dirty. Commit or restore all changes first.",
      );
    }
    assertOfficialRuntimePolicy(runtime);
    rejectCallerProviderBoundaryOverride(options.runtime);
    runtime = {
      ...runtime,
      ...observeOfficialProviderBoundary(),
    };
    assertOfficialProviderBoundary(runtime);
  }

  const manifestWithoutId: Omit<InferenceFreezeManifest, "freeze_id"> = {
    schema_version: FREEZE_SCHEMA_VERSION,
    purpose,
    official,
    created_at: options.createdAt ?? new Date().toISOString(),
    git,
    labels: {
      prompt_version: PROMPT_VERSION,
      rule_version: getRuleVersion(),
      corpus_version: getCorpusVersion(),
      output_schema_version: OUTPUT_SCHEMA_VERSION,
    },
    assets: hashFreezeAssets(),
    runtime,
  };

  const freeze = {
    ...manifestWithoutId,
    freeze_id: freezeIdentity(manifestWithoutId),
  };
  assertArtifactContainsNoSecrets(freeze, [getDeepSeekApiKey()]);
  return freeze;
}

export const createSystemFreeze = createInferenceFreeze;

export function persistSystemFreeze(artifactDir: string, freeze: InferenceFreezeManifest): string {
  const parsed = assertFreezeIntegrity(freeze);
  assertArtifactContainsNoSecrets(parsed, [getDeepSeekApiKey()]);
  const filePath = sealedArtifactPath(artifactDir, "system-freeze", parsed.freeze_id);
  writeSealedJson(filePath, parsed);
  return filePath;
}

export function loadPersistedSystemFreeze(artifactDir: string, freezeId: string): InferenceFreezeManifest {
  const filePath = sealedArtifactPath(artifactDir, "system-freeze", freezeId);
  if (!existsSync(filePath)) {
    throw new HoldoutProtocolError("Official inference is missing a persisted System Freeze");
  }
  return assertFreezeIntegrity(readJsonFile(filePath));
}

export function createOfficialSystemFreeze(options: {
  artifactDir: string;
  runtime?: Partial<FreezeRuntimeConfig>;
  createdAt?: string;
}): InferenceFreezeManifest {
  rejectCallerWorkspaceOverride(options);
  const freeze = createInferenceFreeze({
    purpose: "official",
    runtime: officialFreezeRuntime(options.runtime),
    createdAt: options.createdAt,
  });
  persistSystemFreeze(options.artifactDir, freeze);
  return freeze;
}

export function assertFreezeIntegrity(freeze: unknown): InferenceFreezeManifest {
  const parsed = parseFreezeManifest(freeze);
  const expected = freezeIdentity(parsed);
  if (parsed.freeze_id !== expected) {
    throw new HoldoutProtocolError("Freeze identity does not match sealed freeze contents");
  }
  if (parsed.purpose === "official" && !parsed.official) {
    throw new HoldoutProtocolError("Official freeze purpose must set official=true");
  }
  if (parsed.purpose !== "official" && parsed.official) {
    throw new HoldoutProtocolError("Non-official freeze purpose cannot set official=true");
  }
  return parsed;
}

export function assertFreezeMatchesWorkspace(freeze: InferenceFreezeManifest): void {
  assertFreezeIntegrity(freeze);
  const snapshot = readCanonicalWorkspaceGit();
  if (snapshot.commit !== freeze.git.commit) {
    throw new HoldoutProtocolError(
      `Freeze git commit drifted: workspace ${snapshot.commit} !== freeze ${freeze.git.commit}`,
    );
  }
  if (freeze.official && (freeze.git.dirty || snapshot.dirty)) {
    throw new HoldoutProtocolError("Official freeze is no longer valid: working tree is dirty");
  }
  const current = hashFreezeAssets();
  for (const asset of freeze.assets) {
    const live = current.find((item) => item.path === asset.path);
    if (!live || live.sha256 !== asset.sha256) {
      throw new HoldoutProtocolError(`Freeze asset drifted: ${asset.path}`);
    }
  }
}

export function assertOfficialFreezeUsable(freeze: unknown): InferenceFreezeManifest {
  assertCanonicalProcessCwd();
  const parsed = assertFreezeIntegrity(freeze);
  if (parsed.purpose !== "official" || !parsed.official) {
    throw new HoldoutProtocolError("Freeze is not an official inference freeze");
  }
  if (parsed.git.dirty) {
    throw new HoldoutProtocolError("Official freeze records a dirty working tree and cannot be consumed");
  }
  assertOfficialFreezeAssetInventory(parsed.assets);
  assertOfficialRuntime(parsed.runtime);
  assertOfficialFreezeLabels(parsed);
  assertFreezeMatchesWorkspace(parsed);
  const live = hashFreezeAssets();
  if (live.length !== parsed.assets.length) {
    throw new HoldoutProtocolError("Official freeze asset inventory does not match the frozen workspace");
  }
  for (const asset of live) {
    const frozen = parsed.assets.find((item) => item.path === asset.path);
    if (!frozen || frozen.sha256 !== asset.sha256) {
      throw new HoldoutProtocolError(`Freeze asset drifted: ${asset.path}`);
    }
  }
  return parsed;
}

export function isPathInsideCanonicalWorkspace(targetPath: string): boolean {
  const root = canonicalWorkspaceRoot();
  const resolvedTarget = existsSync(targetPath) ? realpathSync(targetPath) : resolve(targetPath);
  const relativePath = relative(root, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
