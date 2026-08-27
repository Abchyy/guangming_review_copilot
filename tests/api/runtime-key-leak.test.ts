import { inspect } from "node:util";
import fs from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { POST as postReview } from "@/app/api/reviews/route";
import { GET, POST } from "@/app/api/runtime-config/route";
import { RUNTIME_SESSION_COOKIE } from "@/lib/runtime-config";
import {
  resetProductRuntimeForTests,
  setProductRuntimeFactoryForTests,
} from "@/lib/server/product-runtime";
import { getRuntimeSessionStore } from "@/lib/server/runtime-session-store";
import { setReviewStoreForTests } from "@/lib/server/store-singleton";
import { createReviewResponseSchema } from "@grc/contracts";
import { FixtureReviewModel } from "@grc/providers";
import { officialSuccessProvenance, ScriptedReviewModel } from "@grc/test-kit";
import { openReviewDatabase, ReviewStore } from "@grc/review-store";

const DEEPSEEK_CANARY = "sk-leak-deepseek-CANARY-9f3a2b1c";
const TAVILY_CANARY = "tvly-leak-tavily-CANARY-7e8d6c5b";

const demoArticle = JSON.parse(
  fs.readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
) as { title: string; body: string };

function jsonRequest(url: string, body?: unknown, cookie?: string, method = "POST"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) {
    headers.set("cookie", cookie);
  }
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  const header =
    response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`${RUNTIME_SESSION_COOKIE}=([0-9a-f-]+)`, "i"));
  expect(match?.[1]).toBeTruthy();
  return `${RUNTIME_SESSION_COOKIE}=${match![1]}`;
}

function dump(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function expectNoCanary(value: unknown, label: string): void {
  const text = dump(value);
  expect(text, label).not.toContain(DEEPSEEK_CANARY);
  expect(text, label).not.toContain(TAVILY_CANARY);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetProductRuntimeForTests();
  setReviewStoreForTests(undefined);
});

describe("runtime key leak", () => {
  test("keys never appear in HTTP responses, cookies, logs, env, or session serialization", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((item) => dump(item)).join(" "));
      });
    }

    const created = await POST(
      jsonRequest("http://localhost/api/runtime-config", {
        deepseekApiKey: DEEPSEEK_CANARY,
        tavilyApiKey: TAVILY_CANARY,
      }),
    );
    expect(created.status).toBe(200);
    const createdBody: unknown = await created.json();
    const setCookie =
      created.headers.getSetCookie?.().join("\n") ?? created.headers.get("set-cookie") ?? "";
    expectNoCanary(createdBody, "POST /api/runtime-config body");
    expectNoCanary(setCookie, "Set-Cookie");
    expectNoCanary(Object.fromEntries(created.headers.entries()), "response headers");

    const cookie = sessionCookie(created);
    expectNoCanary(cookie, "session cookie value");

    const status = await GET(
      jsonRequest("http://localhost/api/runtime-config", undefined, cookie, "GET"),
    );
    expectNoCanary(await status.json(), "GET /api/runtime-config body");

    setReviewStoreForTests(new ReviewStore(openReviewDatabase(":memory:")));
    setProductRuntimeFactoryForTests((resolved) => ({
      model: resolved.realReviewEnabled
        ? new ScriptedReviewModel({
            provider: "deepseek",
            model: "deepseek-v4-flash",
            candidates: [],
            provenance: officialSuccessProvenance(),
          })
        : new FixtureReviewModel(),
      webEvidenceCollector: null,
      specialistRuntime: null,
      capabilities: {
        real_review: resolved.realReviewEnabled,
        web_evidence: resolved.webEvidenceEnabled,
      },
    }));
    const review = await postReview(
      jsonRequest("http://localhost/api/reviews", demoArticle, cookie),
    );
    const reviewBody = createReviewResponseSchema.parse(await review.json());
    expectNoCanary(reviewBody, "POST /api/reviews body");
    expectNoCanary(review.status, "review status");

    expect(process.env.DEEPSEEK_API_KEY).not.toBe(DEEPSEEK_CANARY);
    expect(process.env.TAVILY_API_KEY).not.toBe(TAVILY_CANARY);
    expectNoCanary(process.env, "process.env");
    expectNoCanary(logs, "console output");
    expectNoCanary(inspect(getRuntimeSessionStore()), "session store inspect");
    expectNoCanary(JSON.stringify(getRuntimeSessionStore()), "session store JSON");

    const rejected = await POST(
      jsonRequest("http://localhost/api/runtime-config", {
        openaiApiKey: DEEPSEEK_CANARY,
        extra: TAVILY_CANARY,
      }),
    );
    expect(rejected.status).toBe(400);
    expectNoCanary(await rejected.json(), "invalid POST error body");
  });

  test("runtime config POST does not persist canaries under .data", async () => {
    await POST(
      jsonRequest("http://localhost/api/runtime-config", {
        deepseekApiKey: DEEPSEEK_CANARY,
        tavilyApiKey: TAVILY_CANARY,
      }),
    );
    const dataDir = join(process.cwd(), ".data");
    if (!fs.existsSync(dataDir)) {
      return;
    }
    const stack = [dataDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const text = fs.readFileSync(full).toString("utf8");
        expect(text, full).not.toContain(DEEPSEEK_CANARY);
        expect(text, full).not.toContain(TAVILY_CANARY);
      }
    }
  });
});
