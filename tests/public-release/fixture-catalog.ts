import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_API_FIXTURE_ROOT = join(here, "../fixtures/public-api");

export type FixtureStep = {
  name: string;
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

export type FixtureScenario = {
  id: string;
  title: string;
  evidence_class: string;
  deployment_status?: string;
  note?: string;
  change_request?: string;
  assertions?: Record<string, unknown>;
  steps: FixtureStep[];
};

export type FixtureCatalog = {
  api_version: string;
  product_working_name: string;
  disclaimer: string;
  live_calls_forbidden: boolean;
  scenarios: Array<{ id: string; file: string; required: boolean }>;
};

type RepeatEncoding = { __repeat: { value: string; count: number } };

function isRepeatEncoding(value: unknown): value is RepeatEncoding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { __repeat?: { value?: unknown; count?: unknown } };
  return (
    typeof candidate.__repeat?.value === "string" &&
    typeof candidate.__repeat.count === "number"
  );
}

export function expandFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(expandFixtureValue);
  }
  if (isRepeatEncoding(value)) {
    return value.__repeat.value.repeat(value.__repeat.count);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = expandFixtureValue(nested);
    }
    return result;
  }
  return value;
}

export function readJson<T>(relativePath: string): T {
  const absolute = join(PUBLIC_API_FIXTURE_ROOT, relativePath);
  return JSON.parse(readFileSync(absolute, "utf8")) as T;
}

export function loadCatalog(): FixtureCatalog {
  return readJson<FixtureCatalog>("catalog.json");
}

export function loadScenario(entry: { id: string; file: string }): FixtureScenario {
  const raw = readJson<FixtureScenario>(entry.file);
  if (raw.id !== entry.id) {
    throw new Error(`Scenario id mismatch: catalog ${entry.id} vs file ${raw.id}`);
  }
  return expandFixtureValue(raw) as FixtureScenario;
}

export function loadAllScenarios(): FixtureScenario[] {
  return loadCatalog().scenarios.map(loadScenario);
}

export function loadSyntheticArticle(): { title: string; body: string } {
  return readJson<{ title: string; body: string }>("articles/synthetic-short.json");
}
