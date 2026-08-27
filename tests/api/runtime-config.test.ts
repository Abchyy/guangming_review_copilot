import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { POST as postReview } from "@/app/api/reviews/route";
import { GET, POST } from "@/app/api/runtime-config/route";
import { isRuntimeConfigStatus } from "@/lib/runtime-config";
import {
  resetProductRuntimeForTests,
  setProductRuntimeFactoryForTests,
} from "@/lib/server/product-runtime";
import { RUNTIME_SESSION_COOKIE } from "@/lib/runtime-config";
import { FixtureReviewModel } from "@grc/providers";
import { createReviewResponseSchema } from "@grc/contracts";
import { openReviewDatabase, ReviewStore } from "@grc/review-store";
import { officialSuccessProvenance, ScriptedReviewModel } from "@grc/test-kit";
import { setReviewStoreForTests } from "@/lib/server/store-singleton";

const demoArticle = JSON.parse(
  readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
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

afterEach(() => {
  resetProductRuntimeForTests();
  setReviewStoreForTests(undefined);
});

describe("GET/POST /api/runtime-config", () => {
  test("GET issues an HttpOnly session cookie and returns status without keys", async () => {
    const response = await GET(new Request("http://localhost/api/runtime-config"));
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(isRuntimeConfigStatus(payload)).toBe(true);
    expect(payload).toMatchObject({
      deepseek: { configured: false, source: "missing" },
      tavily: { configured: false, source: "missing" },
      capabilities: { real_review: false, web_evidence: false },
    });
    const setCookie =
      response.headers.getSetCookie?.().join("\n") ?? response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain(RUNTIME_SESSION_COOKIE);
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  test("POST session keys enable real review and web evidence by default", async () => {
    const created = await POST(
      jsonRequest("http://localhost/api/runtime-config", {
        deepseekApiKey: "sk-session-deepseek",
        tavilyApiKey: "tvly-session",
      }),
    );
    expect(created.status).toBe(200);
    const payload: unknown = await created.json();
    expect(payload).toMatchObject({
      deepseek: { configured: true, source: "session" },
      tavily: { configured: true, source: "session" },
      capabilities: { real_review: true, web_evidence: true },
    });
    expect(JSON.stringify(payload)).not.toContain("sk-session-deepseek");
    expect(JSON.stringify(payload)).not.toContain("tvly-session");

    const cookie = sessionCookie(created);
    const again = await GET(
      jsonRequest("http://localhost/api/runtime-config", undefined, cookie, "GET"),
    );
    expect(await again.json()).toMatchObject({
      capabilities: { real_review: true, web_evidence: true },
    });
  });

  test("POST rejects unknown providers such as OpenAI keys", async () => {
    const response = await POST(
      jsonRequest("http://localhost/api/runtime-config", {
        openaiApiKey: "sk-openai-should-be-rejected",
      }),
    );
    expect(response.status).toBe(400);
    const payload: unknown = await response.json();
    expect(JSON.stringify(payload)).not.toContain("sk-openai-should-be-rejected");
  });

  test("empty DeepSeek key keeps reviews on fixture without live calls", async () => {
    setReviewStoreForTests(new ReviewStore(openReviewDatabase(":memory:")));
    const response = await postReview(jsonRequest("http://localhost/api/reviews", demoArticle));
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await response.json());
    expect(payload.pipeline.provider).toBe("fixture");
    expect(payload.pipeline.web_evidence).toBeUndefined();
  });

  test("session DeepSeek key selects real review through an offline factory", async () => {
    setReviewStoreForTests(new ReviewStore(openReviewDatabase(":memory:")));
    const created = await POST(
      jsonRequest("http://localhost/api/runtime-config", { deepseekApiKey: "sk-session-deepseek" }),
    );
    const cookie = sessionCookie(created);
    setProductRuntimeFactoryForTests((resolved) => ({
      model: resolved.realReviewEnabled
        ? new ScriptedReviewModel({
            provider: "deepseek",
            model: "deepseek-v4-flash",
            candidates: [],
            provenance: officialSuccessProvenance(),
          })
        : new FixtureReviewModel([]),
      webEvidenceCollector: null,
      specialistRuntime: null,
      capabilities: {
        real_review: resolved.realReviewEnabled,
        web_evidence: false,
      },
    }));
    const response = await postReview(
      jsonRequest("http://localhost/api/reviews", demoArticle, cookie),
    );
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await response.json());
    expect(payload.pipeline.provider).toBe("deepseek");
  });
});
