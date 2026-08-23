import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_MARKERS = [
  "package.json",
  "data/rules/catalog.json",
  "data/corpus/references.json",
] as const;

function isWorkspaceRoot(dir: string): boolean {
  return WORKSPACE_MARKERS.every((marker) => existsSync(join(dir, marker)));
}

function discoverWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (isWorkspaceRoot(dir)) {
      return realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Unable to locate immutable canonical workspace from ${startDir}`,
      );
    }
    dir = parent;
  }
}

const CANONICAL_WORKSPACE_ROOT = discoverWorkspaceRoot(
  dirname(fileURLToPath(import.meta.url)),
);

export function canonicalWorkspaceRoot(): string {
  return CANONICAL_WORKSPACE_ROOT;
}

export function realpathOrThrow(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${label} is not a resolvable path: ${path}`);
  }
}

export function processCwdRealpath(): string {
  return realpathOrThrow(process.cwd(), "process cwd");
}

export function processCwdMatchesCanonicalWorkspace(): boolean {
  return processCwdRealpath() === CANONICAL_WORKSPACE_ROOT;
}
