/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_PRODUCTION_MODEL,
  getDeepSeekApiKey,
  getDeepSeekBaseUrl,
  getReviewModelName,
  getReviewProvider,
} from "@grc/providers";
import { DeepSeekReviewModel } from "@grc/providers";
import { OpenAIReviewModel } from "@grc/providers";

import {
  CHALLENGE_LIVE_INTENT,
  DEV_LIVE_INTENT,
  LOCKED_INTENT,
  LIVE_SMOKE_INTENT,
  REGRESSION_LIVE_INTENT,
  applyOfflineTestEnv,
  OFFLINE_MODEL_ENV_KEYS,
} from "@grc/test-kit";

const repoRoot = process.cwd();
const vitestBin = join(repoRoot, "node_modules", ".bin", "vitest");
const liveDir = join(repoRoot, "tests", "live");
const isolationChildFlag = "OFFLINE_ISOLATION_CHILD";
const isIsolationChild = process.env[isolationChildFlag] === "1";

type ListedTest = { name: string; file: string };

function productionLikeModelEnv(): Record<string, string> {
  return {
    REVIEW_PROVIDER: "deepseek",
    REVIEW_MODEL: "hosted-custom-model",
    DEEPSEEK_API_KEY: "sk-prod-like-must-not-be-used",
    DEEPSEEK_BASE_URL: "https://llm-proxy.example.com/v1",
    OPENAI_API_KEY: "sk-openai-prod-like-must-not-be-used",
    OPENAI_BASE_URL: "https://openai-proxy.example.com/v1",
    TAVILY_API_KEY: "tvly-prod-like-must-not-be-used",
    WEB_EVIDENCE_ENABLED: "true",
    [DEV_LIVE_INTENT]: "1",
    [CHALLENGE_LIVE_INTENT]: "1",
    [REGRESSION_LIVE_INTENT]: "1",
    [LOCKED_INTENT]: "1",
    [LIVE_SMOKE_INTENT]: "1",
  };
}

function isolationEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[DEV_LIVE_INTENT];
  delete env[CHALLENGE_LIVE_INTENT];
  delete env[REGRESSION_LIVE_INTENT];
  delete env[LOCKED_INTENT];
  delete env[LIVE_SMOKE_INTENT];
  Object.assign(env, {
    [isolationChildFlag]: "1",
    DEEPSEEK_API_KEY: "sk-fake-must-not-start-live-tests",
    OPENAI_API_KEY: "sk-fake-must-not-start-live-tests",
    TAVILY_API_KEY: "tvly-fake-must-not-start-live-tests",
    WEB_EVIDENCE_ENABLED: "true",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
    ...overrides,
  });
  return env;
}

function runVitest(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(vitestBin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
}

function parseListedTests(stdout: string): ListedTest[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`vitest list did not return JSON: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as ListedTest[];
}

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTsFiles(fullPath);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [fullPath] : [];
  });
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages.join(" | ");
}

async function expectModelCallBlocked(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
    throw new Error("expected offline network guard to block the model client");
  } catch (error) {
    expect(errorMessages(error)).toMatch(/blocked an external model API call/);
  }
}

describe("test / dev-live / locked isolation", () => {
  test("custom model endpoints cannot bypass offline protection", async () => {
    for (const url of [
      "https://llm-proxy.example.com/v1/chat/completions",
      "http://gateway.internal.corp:8080/openai",
      "https://api.together.xyz/v1/chat/completions",
    ]) {
      expect(() => {
        void fetch(url);
      }).toThrow(/blocked an external model API call/);
    }

    expect(() => {
      http.request({ hostname: "llm-proxy.example.com", path: "/v1", protocol: "https:" });
    }).toThrow(/blocked an external model API call to llm-proxy\.example\.com/);

    const deepseek = new DeepSeekReviewModel({
      apiKey: "sk-fake",
      baseURL: "https://llm-proxy.example.com/v1",
    });
    await expectModelCallBlocked(() =>
      deepseek.review({ title: "标题", body: "正文", version: 1 }),
    );

    const openai = new OpenAIReviewModel({
      apiKey: "sk-fake",
    });
    await expectModelCallBlocked(() =>
      openai.review({ title: "标题", body: "正文", version: 1 }),
    );
  });

  test("offline tests sanitize production-like model env to fixture defaults", () => {
    Object.assign(process.env, productionLikeModelEnv());
    applyOfflineTestEnv();

    for (const key of OFFLINE_MODEL_ENV_KEYS) {
      expect(process.env[key], key).toBeUndefined();
    }
    expect(getReviewProvider()).toBe("fixture");
    expect(getReviewModelName("deepseek")).toBe(DEFAULT_PRODUCTION_MODEL);
    expect(getReviewModelName("openai")).toBe("gpt-5.6-terra");
    expect(getDeepSeekApiKey()).toBeUndefined();
    expect(getDeepSeekBaseUrl()).toBe(DEFAULT_DEEPSEEK_BASE_URL);
  });

  test("default collection excludes live inference even when API keys exist", () => {
    const result = runVitest(
      ["list", "--json"],
      isolationEnv({
        ...productionLikeModelEnv(),
      }),
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const listed = parseListedTests(result.stdout);
    expect(listed.length).toBeGreaterThan(0);

    const liveFiles = listed.filter((item) => item.file.includes("/tests/live/"));
    expect(liveFiles).toEqual([]);

    const liveNames = listed.filter((item) =>
      /live smoke|development benchmark|locked evaluation|primary benchmark/i.test(item.name),
    );
    expect(liveNames).toEqual([]);

    const leftoverHarness = listed.filter((item) =>
      /tests\/benchmark\/(?:dev|primary)\.test\.ts$/.test(item.file),
    );
    expect(leftoverHarness).toEqual([]);
  }, 30_000);

  test("package scripts expose explicit live entries and do not start from API keys", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:dev-live"]).toContain("vitest.live.config.mts");
    expect(pkg.scripts["test:dev-live"]).toContain(`${DEV_LIVE_INTENT}=1`);
    expect(pkg.scripts["test:dev-live"]).toContain("tests/live/dev-benchmark.test.ts");
    expect(pkg.scripts["test:challenge-live"]).toContain("vitest.live.config.mts");
    expect(pkg.scripts["test:challenge-live"]).toContain(`${CHALLENGE_LIVE_INTENT}=1`);
    expect(pkg.scripts["test:challenge-live"]).toContain("WEB_EVIDENCE_ENABLED=true");
    expect(pkg.scripts["test:challenge-live"]).toContain("REVIEW_SPECIALISTS_ENABLED=1");
    expect(pkg.scripts["test:challenge-live"]).toContain(
      "tests/live/generalization-challenge.test.ts",
    );
    expect(pkg.scripts["test:regression-live"]).toContain("vitest.live.config.mts");
    expect(pkg.scripts["test:regression-live"]).toContain(`${REGRESSION_LIVE_INTENT}=1`);
    expect(pkg.scripts["test:regression-live"]).toContain("tests/live/regression-benchmark.test.ts");
    expect(pkg.scripts["test:locked"]).toContain("vitest.live.config.mts");
    expect(pkg.scripts["test:locked"]).toContain(`${LOCKED_INTENT}=1`);
    expect(pkg.scripts["test:locked"]).toContain("tests/live/locked-benchmark.test.ts");
    expect(pkg.scripts["test:live-smoke"]).toContain(`${LIVE_SMOKE_INTENT}=1`);
  });

  test("live files require explicit intent flags rather than skipIf(apiKey)", () => {
    const liveFiles = collectTsFiles(liveDir).filter((file) => file.endsWith(".test.ts"));
    expect(liveFiles.length).toBeGreaterThan(0);
    for (const file of liveFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/skipIf\(!apiKey\)/);
      expect(source, file).toMatch(/requireExplicitIntent/);
    }
  });

  test.skipIf(isIsolationChild)(
    "production-like host env does not change ordinary offline tests",
    () => {
      const result = runVitest(
        [
          "run",
          "tests/unit/config.test.ts",
          "tests/unit/deepseek-review-model.test.ts",
          "tests/unit/openai-review-model.test.ts",
        ],
        isolationEnv(productionLikeModelEnv()),
      );
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toMatch(/passed/);
      expect(result.stdout).not.toMatch(/failed/);
    },
    60_000,
  );

  test.skipIf(isIsolationChild)(
    "dev-live and locked refuse to start without opt-in even if API keys exist",
    () => {
      const cases = [
        {
          file: "tests/live/dev-benchmark.test.ts",
          flag: DEV_LIVE_INTENT,
        },
        {
          file: "tests/live/generalization-challenge.test.ts",
          flag: CHALLENGE_LIVE_INTENT,
        },
        {
          file: "tests/live/regression-benchmark.test.ts",
          flag: REGRESSION_LIVE_INTENT,
        },
        {
          file: "tests/live/locked-benchmark.test.ts",
          flag: LOCKED_INTENT,
        },
      ];

      for (const item of cases) {
        const result = runVitest(
          ["run", "--config", "vitest.live.config.mts", item.file],
          isolationEnv(),
        );
        expect(result.status, `${item.file}\n${result.stderr}\n${result.stdout}`).not.toBe(0);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).toContain(item.flag);
        expect(output).not.toMatch(/Unexpected provider|CONTAMINATED|api\.deepseek\.com|401/);
      }
    },
    60_000,
  );
});
