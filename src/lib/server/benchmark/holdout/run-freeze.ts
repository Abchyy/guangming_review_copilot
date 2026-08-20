import { existsSync } from "node:fs";

import { z } from "zod";

import { readJsonFile, sealedArtifactPath, writeSealedJson } from "@/lib/server/benchmark/holdout/artifacts";
import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import {
  assertOfficialFreezeUsable,
  loadPersistedSystemFreeze,
  type SystemFreezeManifest,
} from "@/lib/server/benchmark/holdout/freeze";
import { assertCanonicalProcessCwd, rejectCallerWorkspaceOverride } from "@/lib/server/benchmark/holdout/git-state";
import { sha256Canonical } from "@/lib/server/benchmark/holdout/identity";
import type { InputPack } from "@/lib/server/benchmark/holdout/input-pack";
import { inputPackContentIdentity } from "@/lib/server/benchmark/holdout/input-pack";
import {
  assertFreshOfficialHoldout,
  canonicalOfficialLifecyclePath,
  getHoldoutEntry,
  lifecycleEntryIdentity,
  loadCustodianLifecycle,
  officialCustodianHome,
  rejectOfficialLifecycleOverride,
} from "@/lib/server/benchmark/holdout/lifecycle";
import {
  assertArtifactContainsNoSecrets,
  observeOfficialProviderBoundary,
} from "@/lib/server/benchmark/holdout/provider-identity";
import { getDeepSeekApiKey } from "@/lib/server/config";

export const RUN_FREEZE_SCHEMA_VERSION = "holdout-run-freeze.v1";

export type RunFreezeObservedRuntime = {
  adapter_provider: SystemFreezeManifest["runtime"]["adapter_provider"];
  requested_model: string | null;
  provider_endpoint: string;
  account_boundary_id: string;
};

export type RunFreezeCustodian = {
  home: string;
  lifecycle_path: string;
  identity: string;
};

export type RunFreezeManifest = {
  schema_version: typeof RUN_FREEZE_SCHEMA_VERSION;
  run_freeze_id: string;
  official: true;
  created_at: string;
  system_freeze_id: string;
  holdout_id: string;
  holdout_lifecycle_sha256: string;
  input_pack_id: string;
  input_content_sha256: string;
  article_ids: string[];
  custodian: RunFreezeCustodian;
  observed_runtime: RunFreezeObservedRuntime;
};

export type CreateOfficialRunFreezeOptions = {
  artifactDir: string;
  systemFreeze: SystemFreezeManifest;
  inputPack: InputPack;
  holdoutId: string;
  createdAt?: string;
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const runFreezeSchema = z.object({
  schema_version: z.literal(RUN_FREEZE_SCHEMA_VERSION),
  run_freeze_id: sha256Schema,
  official: z.literal(true),
  created_at: z.string().min(1),
  system_freeze_id: sha256Schema,
  holdout_id: z.string().min(1),
  holdout_lifecycle_sha256: sha256Schema,
  input_pack_id: z.string().min(1),
  input_content_sha256: sha256Schema,
  article_ids: z.array(z.string().min(1)).min(1),
  custodian: z.object({
    home: z.string().min(1),
    lifecycle_path: z.string().min(1),
    identity: sha256Schema,
  }),
  observed_runtime: z.object({
    adapter_provider: z.enum(["fixture", "deepseek", "openai"]),
    requested_model: z.string().nullable(),
    provider_endpoint: z.string().min(1),
    account_boundary_id: sha256Schema,
  }),
});

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

function assertSameArticleSet(expected: string[], actual: string[], label: string): void {
  if (new Set(actual).size !== actual.length) {
    throw new HoldoutProtocolError(`${label} has duplicate article ids`);
  }
  const left = sortedIds(expected);
  const right = sortedIds(actual);
  if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
    throw new HoldoutProtocolError(`${label} article set does not match the holdout dataset`);
  }
}

function custodianIdentity(home: string, lifecyclePath: string): string {
  return sha256Canonical({
    home,
    lifecycle_path: lifecyclePath,
  });
}

function observedRuntimeFromSystem(freeze: SystemFreezeManifest): RunFreezeObservedRuntime {
  if (freeze.runtime.provider_endpoint == null || freeze.runtime.account_boundary_id == null) {
    throw new HoldoutProtocolError("Run Freeze cannot bind a System Freeze that is missing provider provenance");
  }
  return {
    adapter_provider: freeze.runtime.adapter_provider,
    requested_model: freeze.runtime.requested_model,
    provider_endpoint: freeze.runtime.provider_endpoint,
    account_boundary_id: freeze.runtime.account_boundary_id,
  };
}

function runFreezeBody(input: Omit<RunFreezeManifest, "run_freeze_id">): unknown {
  return {
    schema_version: input.schema_version,
    official: input.official,
    system_freeze_id: input.system_freeze_id,
    holdout_id: input.holdout_id,
    holdout_lifecycle_sha256: input.holdout_lifecycle_sha256,
    input_pack_id: input.input_pack_id,
    input_content_sha256: input.input_content_sha256,
    article_ids: sortedIds(input.article_ids),
    custodian: input.custodian,
    observed_runtime: input.observed_runtime,
  };
}

export function runFreezeIdentity(input: Omit<RunFreezeManifest, "run_freeze_id">): string {
  return sha256Canonical(runFreezeBody(input));
}

export function parseRunFreezeManifest(raw: unknown): RunFreezeManifest {
  const parsed = runFreezeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HoldoutProtocolError("Run Freeze does not satisfy the official run freeze contract");
  }
  return parsed.data;
}

export function assertRunFreezeIntegrity(raw: unknown): RunFreezeManifest {
  const parsed = parseRunFreezeManifest(raw);
  const expected = runFreezeIdentity(parsed);
  if (parsed.run_freeze_id !== expected) {
    throw new HoldoutProtocolError("Run Freeze identity does not match sealed run freeze contents");
  }
  return parsed;
}

function assertObservedRuntimeMatchesSystem(
  freeze: SystemFreezeManifest,
  observed: RunFreezeObservedRuntime,
): void {
  const expected = observedRuntimeFromSystem(freeze);
  if (observed.adapter_provider !== expected.adapter_provider) {
    throw new HoldoutProtocolError("Run Freeze cannot change System Freeze adapter provider");
  }
  if (observed.requested_model !== expected.requested_model) {
    throw new HoldoutProtocolError("Run Freeze cannot change System Freeze requested model");
  }
  if (observed.provider_endpoint !== expected.provider_endpoint) {
    throw new HoldoutProtocolError("Run Freeze cannot change System Freeze provider endpoint");
  }
  if (observed.account_boundary_id !== expected.account_boundary_id) {
    throw new HoldoutProtocolError("Run Freeze cannot change System Freeze account boundary identity");
  }
}

function assertLiveRuntimeMatches(observed: RunFreezeObservedRuntime): void {
  const live = observeOfficialProviderBoundary();
  if (observed.provider_endpoint !== live.provider_endpoint) {
    throw new HoldoutProtocolError(
      `Official provider endpoint drifted: live ${live.provider_endpoint} !== freeze ${observed.provider_endpoint}`,
    );
  }
  if (observed.account_boundary_id !== live.account_boundary_id) {
    throw new HoldoutProtocolError("Official provider account boundary identity does not match the live credential");
  }
}

function assertOfficialInputPack(inputPack: InputPack, articleIds: string[]): void {
  if (inputPack.role !== "locked") {
    throw new HoldoutProtocolError(
      `Official Run Freeze cannot bind role ${inputPack.role}. Official locked input must be a hidden external pack.`,
    );
  }
  if (inputPack.in_development_repo) {
    throw new HoldoutProtocolError("Official locked input must not be loaded from the development repo");
  }
  if (inputPackContentIdentity(inputPack) !== inputPack.content_sha256) {
    throw new HoldoutProtocolError("Input pack content identity does not match loaded input contents");
  }
  assertSameArticleSet(
    articleIds,
    inputPack.articles.map((item) => item.article_id),
    "input pack",
  );
}

function liveCustodian(holdoutId: string): RunFreezeCustodian {
  const home = officialCustodianHome();
  const lifecyclePath = canonicalOfficialLifecyclePath(holdoutId);
  return {
    home,
    lifecycle_path: lifecyclePath,
    identity: custodianIdentity(home, lifecyclePath),
  };
}

function assertCustodianMatchesLive(custodian: RunFreezeCustodian, holdoutId: string): void {
  const live = liveCustodian(holdoutId);
  if (custodian.home !== live.home || custodian.lifecycle_path !== live.lifecycle_path) {
    throw new HoldoutProtocolError("Official custodian boundary does not match HOLDOUT_CUSTODIAN_HOME");
  }
  if (custodian.identity !== live.identity) {
    throw new HoldoutProtocolError("Official custodian identity does not match the live custodian boundary");
  }
}

export function persistRunFreeze(artifactDir: string, runFreeze: RunFreezeManifest): string {
  const parsed = assertRunFreezeIntegrity(runFreeze);
  assertArtifactContainsNoSecrets(parsed, [getDeepSeekApiKey()]);
  const filePath = sealedArtifactPath(artifactDir, "run-freeze", parsed.run_freeze_id);
  writeSealedJson(filePath, parsed);
  return filePath;
}

export function loadPersistedRunFreeze(artifactDir: string, runFreezeId: string): RunFreezeManifest {
  const filePath = sealedArtifactPath(artifactDir, "run-freeze", runFreezeId);
  if (!existsSync(filePath)) {
    throw new HoldoutProtocolError("Official inference is missing a persisted Run Freeze");
  }
  return assertRunFreezeIntegrity(readJsonFile(filePath));
}

export function createOfficialRunFreeze(options: CreateOfficialRunFreezeOptions): RunFreezeManifest {
  rejectCallerWorkspaceOverride(options);
  rejectOfficialLifecycleOverride(options);
  assertCanonicalProcessCwd();

  const persisted = loadPersistedSystemFreeze(options.artifactDir, options.systemFreeze.freeze_id);
  if (persisted.freeze_id !== options.systemFreeze.freeze_id) {
    throw new HoldoutProtocolError("System Freeze identity does not match the persisted System Freeze");
  }
  const systemFreeze = assertOfficialFreezeUsable(persisted);
  if (systemFreeze.freeze_id !== options.systemFreeze.freeze_id) {
    throw new HoldoutProtocolError("System Freeze identity does not match the persisted System Freeze");
  }

  const custodian = liveCustodian(options.holdoutId);
  if (!existsSync(custodian.lifecycle_path)) {
    throw new HoldoutProtocolError("Official holdout lifecycle was not found at the unique custodian path");
  }
  const registry = loadCustodianLifecycle(custodian.lifecycle_path);
  const entry = getHoldoutEntry(registry, options.holdoutId);
  assertFreshOfficialHoldout(entry);
  assertOfficialInputPack(options.inputPack, entry.article_ids);

  const observedRuntime = observedRuntimeFromSystem(systemFreeze);
  assertObservedRuntimeMatchesSystem(systemFreeze, observedRuntime);
  assertLiveRuntimeMatches(observedRuntime);

  const manifestWithoutId: Omit<RunFreezeManifest, "run_freeze_id"> = {
    schema_version: RUN_FREEZE_SCHEMA_VERSION,
    official: true,
    created_at: options.createdAt ?? new Date().toISOString(),
    system_freeze_id: systemFreeze.freeze_id,
    holdout_id: options.holdoutId,
    holdout_lifecycle_sha256: lifecycleEntryIdentity(entry),
    input_pack_id: options.inputPack.pack_id,
    input_content_sha256: options.inputPack.content_sha256,
    article_ids: sortedIds(entry.article_ids),
    custodian,
    observed_runtime: observedRuntime,
  };
  const runFreeze: RunFreezeManifest = {
    ...manifestWithoutId,
    run_freeze_id: runFreezeIdentity(manifestWithoutId),
  };
  assertArtifactContainsNoSecrets(runFreeze, [getDeepSeekApiKey()]);
  persistRunFreeze(options.artifactDir, runFreeze);
  return runFreeze;
}

export function assertOfficialRunFreezeUsable(input: {
  runFreeze: unknown;
  systemFreeze: SystemFreezeManifest;
  inputPack: InputPack;
  artifactDir: string;
}): RunFreezeManifest {
  assertCanonicalProcessCwd();
  const parsed = assertRunFreezeIntegrity(input.runFreeze);
  if (!parsed.official) {
    throw new HoldoutProtocolError("Run Freeze is not official");
  }

  const persistedRun = loadPersistedRunFreeze(input.artifactDir, parsed.run_freeze_id);
  if (persistedRun.run_freeze_id !== parsed.run_freeze_id) {
    throw new HoldoutProtocolError("Run Freeze identity does not match the persisted Run Freeze");
  }

  const persistedSystem = loadPersistedSystemFreeze(input.artifactDir, parsed.system_freeze_id);
  const systemFreeze = assertOfficialFreezeUsable(persistedSystem);
  if (systemFreeze.freeze_id !== parsed.system_freeze_id) {
    throw new HoldoutProtocolError("Run Freeze System Freeze identity does not match the persisted System Freeze");
  }
  if (systemFreeze.freeze_id !== input.systemFreeze.freeze_id) {
    throw new HoldoutProtocolError("System Freeze identity does not match Run Freeze");
  }

  assertObservedRuntimeMatchesSystem(systemFreeze, parsed.observed_runtime);
  assertLiveRuntimeMatches(parsed.observed_runtime);
  assertCustodianMatchesLive(parsed.custodian, parsed.holdout_id);

  if (!existsSync(parsed.custodian.lifecycle_path)) {
    throw new HoldoutProtocolError("Official holdout lifecycle was not found at the unique custodian path");
  }
  const registry = loadCustodianLifecycle(parsed.custodian.lifecycle_path);
  const entry = getHoldoutEntry(registry, parsed.holdout_id);
  assertFreshOfficialHoldout(entry);
  if (lifecycleEntryIdentity(entry) !== parsed.holdout_lifecycle_sha256) {
    throw new HoldoutProtocolError("Holdout lifecycle identity does not match Run Freeze");
  }
  assertOfficialInputPack(input.inputPack, parsed.article_ids);
  if (input.inputPack.pack_id !== parsed.input_pack_id) {
    throw new HoldoutProtocolError(
      `Input pack_id ${input.inputPack.pack_id} does not match Run Freeze ${parsed.input_pack_id}`,
    );
  }
  if (input.inputPack.content_sha256 !== parsed.input_content_sha256) {
    throw new HoldoutProtocolError("Input pack content identity does not match Run Freeze");
  }
  return parsed;
}
