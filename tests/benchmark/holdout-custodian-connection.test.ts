/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const workspace = process.cwd();
const statusScript = join(workspace, "scripts", "holdout-status.mjs");

function externalCustodian(status: "available" | "consumed") {
  const home = mkdtempSync(join(tmpdir(), "holdout-custodian-connection-"));
  const holdoutId = "external-holdout-v1";
  const holdoutRoot = join(home, "holdouts", holdoutId);
  mkdirSync(join(holdoutRoot, "input"), { recursive: true });
  mkdirSync(join(holdoutRoot, "hidden"), { recursive: true });
  writeFileSync(join(holdoutRoot, "input", "locked-input.json"), "not-read-by-status-command\n");
  writeFileSync(join(holdoutRoot, "hidden", "gold.json"), "must-never-be-read\n");
  writeFileSync(
    join(holdoutRoot, "lifecycle.json"),
    `${JSON.stringify({
      schema_version: "holdout-registry.v1",
      entries: [
        {
          holdout_id: holdoutId,
          role: "locked",
          status,
          contamination: null,
          in_repo: false,
          gold_in_development_repo: false,
          may_claim_fresh_locked_generalization: status === "available",
          article_ids: ["secret-article-id"],
          notes: "external fixture",
          result_id: status === "consumed" ? "result-secret" : null,
        },
      ],
    })}\n`,
  );
  return { home, holdoutId };
}

function runStatus(home: string) {
  return spawnSync(process.execPath, [statusScript], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, HOLDOUT_CUSTODIAN_HOME: home },
  });
}

describe("external holdout custodian connection", () => {
  test("reports only safe lifecycle metadata and never emits article or gold content", () => {
    const fixture = externalCustodian("consumed");
    const result = runStatus(fixture.home);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      hidden_content_read: boolean;
      holdouts: Array<Record<string, unknown>>;
    };
    expect(report.hidden_content_read).toBe(false);
    expect(report.holdouts).toEqual([
      expect.objectContaining({
        holdout_id: fixture.holdoutId,
        status: "consumed",
        official_run_eligibility: "historical_consumed",
      }),
    ]);
    expect(result.stdout).not.toContain("secret-article-id");
    expect(result.stdout).not.toContain("must-never-be-read");
  });

  test("recognizes a fresh external lifecycle without consuming it", () => {
    const fixture = externalCustodian("available");
    const result = runStatus(fixture.home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"official_run_eligibility": "eligible_for_new_official_run"');
    const lifecycle = join(fixture.home, "holdouts", fixture.holdoutId, "lifecycle.json");
    expect(JSON.parse(readFileSync(lifecycle, "utf8")).entries[0].status).toBe("available");
  });

  test("rejects a custodian path inside the development repository", () => {
    const result = runStatus(join(workspace, "data"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the development repository");
  });
});
