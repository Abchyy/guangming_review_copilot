import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_SCHEMA_VERSION = "holdout-registry.v1";

function fail(message) {
  throw new Error(`Holdout connection refused: ${message}`);
}

function pathIsInside(parent, target) {
  const child = relative(parent, target);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function parseLifecycle(filePath, expectedHoldoutId) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot parse lifecycle for ${expectedHoldoutId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || raw.schema_version !== REGISTRY_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
    fail(`lifecycle for ${expectedHoldoutId} does not satisfy ${REGISTRY_SCHEMA_VERSION}`);
  }
  const entry = raw.entries.find((item) => item?.holdout_id === expectedHoldoutId);
  if (!entry) {
    fail(`lifecycle does not contain directory holdout_id ${expectedHoldoutId}`);
  }
  const allowedRoles = new Set(["dev", "regression", "locked", "protocol_fixture"]);
  const allowedStatuses = new Set(["available", "consuming", "consumed"]);
  if (!allowedRoles.has(entry.role) || !allowedStatuses.has(entry.status)) {
    fail(`lifecycle for ${expectedHoldoutId} has an invalid role or status`);
  }
  return entry;
}

function eligibility(entry) {
  if (entry.role !== "locked") return "not_locked";
  if (entry.status !== "available") return `historical_${entry.status}`;
  if (entry.contamination) return "contaminated";
  if (entry.in_repo || entry.gold_in_development_repo) return "development_boundary_violation";
  if (!entry.may_claim_fresh_locked_generalization) return "fresh_claim_disabled";
  return "eligible_for_new_official_run";
}

export function inspectCustodianConnection({ configuredHome, workspaceRoot = process.cwd() }) {
  const configured = configuredHome?.trim();
  if (!configured) {
    fail("HOLDOUT_CUSTODIAN_HOME is not configured");
  }
  if (!existsSync(configured)) {
    fail(`custodian home does not exist: ${configured}`);
  }
  const home = realpathSync(configured);
  const workspace = realpathSync(resolve(workspaceRoot));
  if (pathIsInside(workspace, home)) {
    fail("custodian home must be outside the development repository");
  }

  const holdoutsRoot = join(home, "holdouts");
  if (!existsSync(holdoutsRoot)) {
    fail(`missing holdouts directory under ${home}`);
  }

  const holdouts = readdirSync(holdoutsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((directory) => {
      const holdoutId = directory.name;
      const holdoutRoot = join(holdoutsRoot, holdoutId);
      const lifecyclePath = join(holdoutRoot, "lifecycle.json");
      if (!existsSync(lifecyclePath)) {
        fail(`missing lifecycle.json for ${holdoutId}`);
      }
      const entry = parseLifecycle(lifecyclePath, holdoutId);
      return {
        holdout_id: holdoutId,
        role: entry.role,
        status: entry.status,
        contamination: entry.contamination ?? null,
        may_claim_fresh_locked_generalization:
          entry.may_claim_fresh_locked_generalization === true,
        result_id: typeof entry.result_id === "string" ? entry.result_id : null,
        input_pack_present: existsSync(join(holdoutRoot, "input", "locked-input.json")),
        hidden_boundary_present: existsSync(join(holdoutRoot, "hidden")),
        official_run_eligibility: eligibility(entry),
      };
    })
    .sort((left, right) => left.holdout_id.localeCompare(right.holdout_id));

  return {
    custodian_home: home,
    boundary: "external_custodian",
    hidden_content_read: false,
    holdouts,
  };
}

function main() {
  try {
    const report = inspectCustodianConnection({
      configuredHome: process.env.HOLDOUT_CUSTODIAN_HOME,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
