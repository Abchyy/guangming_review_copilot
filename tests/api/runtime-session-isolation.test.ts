import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { POST as postReview } from "@/app/api/reviews/route";
import { GET, POST } from "@/app/api/runtime-config/route";
import { RUNTIME_SESSION_COOKIE } from "@/lib/runtime-config";
import {
  resetProductRuntimeForTests,
  setProductRuntimeFactoryForTests,
} from "@/lib/server/product-runtime";
import { resetRuntimeSessionStore } from "@/lib/server/runtime-session-store";
import { setReviewStoreForTests } from "@/lib/server/store-singleton";
import { createReviewResponseSchema } from "@grc/contracts";
import { FixtureReviewModel } from "@grc/providers";
import { officialSuccessProvenance, ScriptedReviewModel } from "@grc/test-kit";
import { openReviewDatabase, ReviewStore } from "@grc/review-store";

const demoArticle = JSON.parse(
  readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
) as { title: string; body: string };

const KEY_A = "sk-session-a-ISOLATION";
const KEY_B = "sk-session-b-ISOLATION";

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

describe("runtime session isolation", () => {
  test("two cookies keep independent DeepSeek keys", async () => {
    const first = await POST(
      jsonRequest("http://localhost/api/runtime-config", { deepseekApiKey: KEY_A }),
    );
    const cookieA = sessionCookie(first);
    const second = await POST(
      jsonRequest("http://localhost/api/runtime-config", { deepseekApiKey: KEY_B }),
    );
    const cookieB = sessionCookie(second);

    const statusA = await (await GET(jsonRequest("http://localhost/api/runtime-config", undefined, cookieA, "GET"))).json();
    const statusB = await (await GET(jsonRequest("http://localhost/api/runtime-config", undefined, cookieB, "GET"))).json();
    expect(statusA).toMatchObject({
      deepseek: { configured: true, source: "session" },
      capabilities: { real_review: true },
    });
    expect(statusB).toMatchObject({
      deepseek: { configured: true, source: "session" },
      capabilities: { real_review: true },
    });
    expect(JSON.stringify(statusA)).not.toContain(KEY_A);
    expect(JSON.stringify(statusA)).not.toContain(KEY_B);
    expect(JSON.stringify(statusB)).not.toContain(KEY_A);
    expect(JSON.stringify(statusB)).not.toContain(KEY_B);

    const seen: string[] = [];
    setReviewStoreForTests(new ReviewStore(openReviewDatabase(":memory:")));
    setProductRuntimeFactoryForTests((resolved) => {
      seen.push(resolved.deepseekApiKey ?? "");
      return {
        model: new ScriptedReviewModel({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          candidates: [],
          provenance: officialSuccessProvenance(),
        }),
        webEvidenceCollector: null,
        specialistRuntime: null,
        capabilities: { real_review: true, web_evidence: false },
      };
    });

    await postReview(jsonRequest("http://localhost/api/reviews", demoArticle, cookieA));
    await postReview(jsonRequest("http://localhost/api/reviews", demoArticle, cookieB));
    expect(seen).toEqual([KEY_A, KEY_B]);
  });

  test("a session cannot enable another session's Tavily capability", async () => {
    const withTavily = await POST(
      jsonRequest("http://localhost/api/runtime-config", { tavilyApiKey: "tvly-session-only" }),
    );
    const cookieWith = sessionCookie(withTavily);
    const without = await POST(jsonRequest("http://localhost/api/runtime-config", {}));
    const cookieWithout = sessionCookie(without);

    const enabled = await (
      await GET(jsonRequest("http://localhost/api/runtime-config", undefined, cookieWith, "GET"))
    ).json();
    const disabled = await (
      await GET(jsonRequest("http://localhost/api/runtime-config", undefined, cookieWithout, "GET"))
    ).json();
    expect(enabled).toMatchObject({ capabilities: { web_evidence: true } });
    expect(disabled).toMatchObject({ capabilities: { web_evidence: false } });
  });

  test("process restart clears session keys for an existing cookie", async () => {
    const created = await POST(
      jsonRequest("http://localhost/api/runtime-config", { deepseekApiKey: KEY_A }),
    );
    const cookie = sessionCookie(created);
    resetRuntimeSessionStore();
    const afterRestart = await GET(
      jsonRequest("http://localhost/api/runtime-config", undefined, cookie, "GET"),
    );
    expect(await afterRestart.json()).toMatchObject({
      deepseek: { configured: false, source: "missing" },
      capabilities: { real_review: false, web_evidence: false },
    });
  });

  test("review without a cookie stays on fixture when no env keys are set", async () => {
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
        web_evidence: false,
      },
    }));
    const response = await postReview(jsonRequest("http://localhost/api/reviews", demoArticle));
    const payload = createReviewResponseSchema.parse(await response.json());
    expect(payload.pipeline.provider).toBe("fixture");
  });
});
