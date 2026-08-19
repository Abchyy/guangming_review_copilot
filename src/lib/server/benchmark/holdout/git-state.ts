import { spawnSync } from "node:child_process";

import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import {
  canonicalWorkspaceRoot,
  processCwdMatchesCanonicalWorkspace,
} from "@/lib/server/workspace-identity";

export type GitSnapshot = {
  commit: string;
  dirty: boolean;
  porcelain: string;
};

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new HoldoutProtocolError(
      `Refusing freeze: git ${args.join(" ")} failed (${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`})`,
    );
  }
  return result.stdout;
}

function inspectGit(workspace: string): GitSnapshot {
  const commit = runGit(["rev-parse", "HEAD"], workspace).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new HoldoutProtocolError("Refusing freeze: git HEAD is not a full commit hash");
  }
  const porcelain = runGit(["status", "--porcelain"], workspace);
  return {
    commit,
    dirty: porcelain.trim().length > 0,
    porcelain,
  };
}

export { canonicalWorkspaceRoot };

export function readCanonicalWorkspaceGit(): GitSnapshot {
  return inspectGit(canonicalWorkspaceRoot());
}

export function assertCanonicalProcessCwd(): void {
  try {
    if (!processCwdMatchesCanonicalWorkspace()) {
      throw new HoldoutProtocolError(
        "Official workspace identity drifted: process cwd is not the canonical workspace",
      );
    }
  } catch (error) {
    if (error instanceof HoldoutProtocolError) {
      throw error;
    }
    throw new HoldoutProtocolError(
      "Official workspace identity drifted: process cwd is not the canonical workspace",
      { cause: error },
    );
  }
}

export function rejectCallerWorkspaceOverride(options: object): void {
  const record = options as Record<string, unknown>;
  if (record.repoRoot != null || record.workspaceRoot != null || record.cwd != null) {
    throw new HoldoutProtocolError("Official workspace identity cannot be redirected by the caller");
  }
  if (record.git != null || record.gitSnapshot != null || record.workspaceGit != null) {
    throw new HoldoutProtocolError("Official Git observation cannot be supplied by the caller");
  }
}
