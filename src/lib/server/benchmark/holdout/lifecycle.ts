import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { isPathInsideCanonicalWorkspace } from "@/lib/server/benchmark/holdout/freeze";
import { canonicalWorkspaceRoot } from "@/lib/server/benchmark/holdout/git-state";
import { sha256Canonical } from "@/lib/server/benchmark/holdout/identity";
import type { HoldoutRole, HoldoutStatus } from "@/lib/server/benchmark/holdout/roles";

export const HOLDOUT_REGISTRY_SCHEMA_VERSION = "holdout-registry.v1";
export const LEGACY_LOCKED_HOLDOUT_ID = "legacy-m3-locked-12";
export const HOLDOUT_CUSTODIAN_HOME_ENV = "HOLDOUT_CUSTODIAN_HOME";

const registryEntrySchema = z.object({
  holdout_id: z.string().min(1),
  role: z.enum(["dev", "regression", "locked", "protocol_fixture"]),
  status: z.enum(["available", "consuming", "consumed"]),
  contamination: z.string().nullable(),
  in_repo: z.boolean(),
  gold_in_development_repo: z.boolean(),
  may_claim_fresh_locked_generalization: z.boolean(),
  article_ids: z.array(z.string().min(1)),
  notes: z.string().min(1),
  result_id: z.string().nullable().optional(),
});

const registrySchema = z.object({
  schema_version: z.literal(HOLDOUT_REGISTRY_SCHEMA_VERSION),
  entries: z.array(registryEntrySchema),
});

export type HoldoutRegistryEntry = z.infer<typeof registryEntrySchema>;
export type HoldoutRegistry = z.infer<typeof registrySchema>;

export function parseHoldoutRegistry(raw: unknown): HoldoutRegistry {
  return registrySchema.parse(raw);
}

export function loadHoldoutRegistry(): HoldoutRegistry {
  const filePath = join(canonicalWorkspaceRoot(), "data", "benchmark", "holdout-registry.json");
  return parseHoldoutRegistry(JSON.parse(readFileSync(filePath, "utf8")));
}

export function loadCustodianLifecycle(filePath: string): HoldoutRegistry {
  return parseHoldoutRegistry(JSON.parse(readFileSync(filePath, "utf8")));
}

export function writeCustodianLifecycle(filePath: string, registry: HoldoutRegistry): void {
  atomicWriteJson(filePath, parseHoldoutRegistry(registry));
}

export function getHoldoutEntry(registry: HoldoutRegistry, holdoutId: string): HoldoutRegistryEntry {
  const entry = registry.entries.find((item) => item.holdout_id === holdoutId);
  if (!entry) {
    throw new HoldoutProtocolError(`Unknown holdout_id: ${holdoutId}`);
  }
  return entry;
}

/** Stable holdout identity. Excludes status / result_id so a result can verify the final consumed record. */
export function lifecycleEntryIdentity(entry: HoldoutRegistryEntry): string {
  return sha256Canonical({
    holdout_id: entry.holdout_id,
    role: entry.role,
    contamination: entry.contamination,
    article_ids: [...entry.article_ids].sort(),
  });
}

export function assertFreshOfficialHoldout(entry: HoldoutRegistryEntry): void {
  if (entry.role !== "locked") {
    throw new HoldoutProtocolError(
      `Refusing official locked claim: holdout ${entry.holdout_id} has role ${entry.role}, not locked`,
    );
  }
  if (entry.status !== "available") {
    throw new HoldoutProtocolError(
      `Refusing official locked claim: holdout ${entry.holdout_id} is ${entry.status} and cannot be used as fresh locked generalization evidence`,
    );
  }
  if (entry.contamination) {
    throw new HoldoutProtocolError(
      `Refusing official locked claim: holdout ${entry.holdout_id} is contaminated (${entry.contamination})`,
    );
  }
  if (entry.gold_in_development_repo || entry.in_repo) {
    throw new HoldoutProtocolError(
      "Refusing official locked claim: hidden gold must not live in the development repo",
    );
  }
  if (!entry.may_claim_fresh_locked_generalization) {
    throw new HoldoutProtocolError(
      `Refusing official locked claim: holdout ${entry.holdout_id} may not be used as fresh locked generalization evidence`,
    );
  }
}

export function markHoldoutConsumed(
  registry: HoldoutRegistry,
  holdoutId: string,
  resultId?: string,
): HoldoutRegistry {
  const entry = getHoldoutEntry(registry, holdoutId);
  if (entry.status === "consumed") {
    throw new HoldoutProtocolError(
      `Holdout ${holdoutId} is already consumed and cannot be evaluated again as a fresh locked set`,
    );
  }
  return {
    ...registry,
    entries: registry.entries.map((item) =>
      item.holdout_id === holdoutId
        ? {
            ...item,
            status: "consumed" as HoldoutStatus,
            may_claim_fresh_locked_generalization: false,
            result_id: resultId ?? item.result_id ?? null,
          }
        : item,
    ),
  };
}

export function protocolFixtureRegistry(articleIds: string[]): HoldoutRegistry {
  return {
    schema_version: HOLDOUT_REGISTRY_SCHEMA_VERSION,
    entries: [
      {
        holdout_id: "protocol-fixture-v1",
        role: "protocol_fixture" as HoldoutRole,
        status: "available",
        contamination: null,
        in_repo: true,
        gold_in_development_repo: true,
        may_claim_fresh_locked_generalization: false,
        article_ids: articleIds,
        notes: "Synthetic protocol fixture. Not official locked gold.",
      },
    ],
  };
}

export function syntheticLockedRegistry(input: {
  holdoutId: string;
  articleIds: string[];
}): HoldoutRegistry {
  return {
    schema_version: HOLDOUT_REGISTRY_SCHEMA_VERSION,
    entries: [
      {
        holdout_id: input.holdoutId,
        role: "locked",
        status: "available",
        contamination: null,
        in_repo: false,
        gold_in_development_repo: false,
        may_claim_fresh_locked_generalization: true,
        article_ids: input.articleIds,
        notes: "Synthetic locked lifecycle fixture for protocol tests. Not Benchmark Corpus v2 hidden gold.",
      },
    ],
  };
}

export function assertOfficialLifecyclePath(filePath: string): void {
  if (isPathInsideCanonicalWorkspace(filePath)) {
    throw new HoldoutProtocolError(
      "Official holdout lifecycle must be a custodian-controlled file outside the development repo",
    );
  }
}

export function officialCustodianHome(): string {
  const configured = process.env[HOLDOUT_CUSTODIAN_HOME_ENV]?.trim();
  if (!configured) {
    throw new HoldoutProtocolError(
      `Official evaluation requires ${HOLDOUT_CUSTODIAN_HOME_ENV} to locate the unique custodian lifecycle`,
    );
  }
  const resolved = existsSync(configured) ? realpathSync(configured) : resolve(configured);
  assertOfficialLifecyclePath(resolved);
  return resolved;
}

export function canonicalOfficialLifecyclePath(holdoutId: string): string {
  return join(officialCustodianHome(), "holdouts", holdoutId, "lifecycle.json");
}

export function rejectOfficialLifecycleOverride(options: object): void {
  const record = options as { lifecyclePath?: unknown };
  if (record.lifecyclePath != null) {
    throw new HoldoutProtocolError("Official lifecycle cannot be redirected by the caller");
  }
}

export function claimFilePath(lifecyclePath: string, holdoutId: string): string {
  return `${lifecyclePath}.${holdoutId}.claim`;
}

export function claimHoldoutConsumption(lifecyclePath: string, holdoutId: string): HoldoutRegistry {
  const claimPath = claimFilePath(lifecyclePath, holdoutId);
  try {
    writeFileSync(claimPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
  } catch {
    throw new HoldoutProtocolError(
      `Holdout ${holdoutId} is already claimed or consumed and cannot be used as fresh`,
    );
  }
  let persisted = false;
  try {
    const registry = loadCustodianLifecycle(lifecyclePath);
    const entry = getHoldoutEntry(registry, holdoutId);
    if (entry.status !== "available") {
      throw new HoldoutProtocolError(
        `Holdout ${holdoutId} is ${entry.status} and cannot be consumed as fresh`,
      );
    }
    const next: HoldoutRegistry = {
      ...registry,
      entries: registry.entries.map((item) =>
        item.holdout_id === holdoutId
          ? {
              ...item,
              status: "consuming" as HoldoutStatus,
              may_claim_fresh_locked_generalization: false,
            }
          : item,
      ),
    };
    atomicWriteJson(lifecyclePath, next);
    persisted = true;
    return next;
  } catch (error) {
    if (!persisted) {
      try {
        unlinkSync(claimPath);
      } catch {
        // Claim file remains as a fail-closed reservation if unlink fails.
      }
    }
    throw error;
  }
}

export function completeHoldoutConsumption(
  lifecyclePath: string,
  holdoutId: string,
  resultId: string,
): HoldoutRegistry {
  const registry = loadCustodianLifecycle(lifecyclePath);
  const next = markHoldoutConsumed(registry, holdoutId, resultId);
  atomicWriteJson(lifecyclePath, next);
  try {
    unlinkSync(claimFilePath(lifecyclePath, holdoutId));
  } catch {
    // Consumed JSON is the source of truth even if the claim file lingers.
  }
  return next;
}

export function releaseHoldoutClaim(lifecyclePath: string, holdoutId: string): void {
  if (!existsSync(lifecyclePath)) {
    return;
  }
  const registry = loadCustodianLifecycle(lifecyclePath);
  const entry = getHoldoutEntry(registry, holdoutId);
  if (entry.status === "consumed") {
    return;
  }
  if (entry.status === "consuming") {
    const restored: HoldoutRegistry = {
      ...registry,
      entries: registry.entries.map((item) =>
        item.holdout_id === holdoutId
          ? {
              ...item,
              status: "available" as HoldoutStatus,
              may_claim_fresh_locked_generalization: item.role === "locked" && !item.contamination,
            }
          : item,
      ),
    };
    atomicWriteJson(lifecyclePath, restored);
  }
  try {
    unlinkSync(claimFilePath(lifecyclePath, holdoutId));
  } catch {
    // Ignore a missing claim file during pre-result rollback.
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tmp = join(
    directory,
    `.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, filePath);
}
