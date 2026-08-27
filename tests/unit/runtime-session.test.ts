/** @vitest-environment node */
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createProductRuntime } from "@/lib/server/product-runtime";
import {
  resolveRuntimeSecrets,
  toRuntimeConfigStatus,
} from "@/lib/server/runtime-secrets";
import {
  RuntimeSessionStore,
  resetRuntimeSessionStore,
} from "@/lib/server/runtime-session-store";

const CANARY = "sk-unit-canary-MUST-NOT-LEAK";

afterEach(() => {
  resetRuntimeSessionStore();
});

describe("runtime session secrets", () => {
  test("stores keys only in memory and redacts them from inspect and JSON", () => {
    const store = new RuntimeSessionStore();
    store.put("sid-a", { deepseekApiKey: CANARY, tavilyApiKey: "tvly-unit-canary" });
    expect(store.get("sid-a")?.deepseekApiKey).toBe(CANARY);
    expect(inspect(store)).not.toContain(CANARY);
    expect(inspect(store.get("sid-a"))).not.toContain(CANARY);
    expect(JSON.stringify(store)).not.toContain(CANARY);
    expect(JSON.stringify(store.get("sid-a"))).not.toContain(CANARY);
    expect(JSON.stringify(store.get("sid-a"))).toBe(JSON.stringify({ deepseek: true, tavily: true }));
  });

  test("clearing the store simulates process restart", () => {
    const store = new RuntimeSessionStore();
    store.put("sid-a", { deepseekApiKey: CANARY });
    store.clear();
    expect(store.get("sid-a")).toBeUndefined();
  });

  test("session store module does not import filesystem APIs", () => {
    const source = readFileSync(
      join(process.cwd(), "apps/web/src/lib/server/runtime-session-store.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/node:fs|fs\/promises|writeFile|appendFile/);
  });
});

describe("runtime secret resolution", () => {
  test("missing DeepSeek key disables real review; missing Tavily only disables web evidence", () => {
    const resolved = resolveRuntimeSecrets(undefined, {});
    expect(toRuntimeConfigStatus(resolved)).toEqual({
      deepseek: { configured: false, source: "missing" },
      tavily: { configured: false, source: "missing" },
      capabilities: { real_review: false, web_evidence: false },
    });
    const runtime = createProductRuntime(resolved);
    expect(runtime.model.provider).toBe("fixture");
    expect(runtime.webEvidenceCollector).toBeNull();
  });

  test("session DeepSeek and Tavily keys enable the corresponding capabilities by default", () => {
    const resolved = resolveRuntimeSecrets(
      { deepseekApiKey: "sk-session-deepseek", tavilyApiKey: "tvly-session" },
      { REVIEW_PROVIDER: "fixture", WEB_EVIDENCE_ENABLED: "false" },
    );
    expect(resolved.deepseekSource).toBe("session");
    expect(resolved.tavilySource).toBe("session");
    expect(resolved.realReviewEnabled).toBe(true);
    expect(resolved.webEvidenceEnabled).toBe(true);
    const runtime = createProductRuntime(resolved);
    expect(runtime.model.provider).toBe("deepseek");
    expect(runtime.webEvidenceCollector).not.toBeNull();
  });

  test("env development mode still requires existing flags", () => {
    const deepseekOnly = resolveRuntimeSecrets(undefined, {
      DEEPSEEK_API_KEY: "sk-env-deepseek",
      TAVILY_API_KEY: "tvly-env",
    });
    expect(deepseekOnly.deepseekSource).toBe("environment");
    expect(deepseekOnly.realReviewEnabled).toBe(false);
    expect(deepseekOnly.webEvidenceEnabled).toBe(false);

    const enabled = resolveRuntimeSecrets(undefined, {
      DEEPSEEK_API_KEY: "sk-env-deepseek",
      REVIEW_PROVIDER: "deepseek",
      TAVILY_API_KEY: "tvly-env",
      WEB_EVIDENCE_ENABLED: "true",
    });
    expect(enabled.realReviewEnabled).toBe(true);
    expect(enabled.webEvidenceEnabled).toBe(true);
    expect(createProductRuntime(enabled).model.provider).toBe("deepseek");
  });

  test("status DTO never includes key material", () => {
    const status = toRuntimeConfigStatus(
      resolveRuntimeSecrets({ deepseekApiKey: CANARY, tavilyApiKey: "tvly-unit-canary" }),
    );
    expect(JSON.stringify(status)).not.toContain(CANARY);
    expect(JSON.stringify(status)).not.toContain("tvly-unit-canary");
    expect(status.deepseek.configured).toBe(true);
    expect(status.tavily.configured).toBe(true);
  });
});
