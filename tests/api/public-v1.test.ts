import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as postWechatAuth } from "@/app/api/v1/auth/wechat/route";
import { PATCH as patchFinding } from "@/app/api/v1/reviews/[reviewId]/findings/[findingId]/route";
import { DELETE as deleteReview, GET as getReview } from "@/app/api/v1/reviews/[reviewId]/route";
import { POST as postReview } from "@/app/api/v1/reviews/route";
import {
  FIXTURE_WECHAT_CODES,
  createFailClosedPublicApiRuntime,
  createFixturePublicApiRuntime,
  createPublicApiRuntimeFromEnv,
  resetPublicApiRuntimeForTests,
  setPublicApiRuntimeForTests,
} from "@/lib/server/public-api/runtime";
import {
  PUBLIC_BODY_MAX_LENGTH,
  PUBLIC_PRIVACY_NOTICE_VERSION,
  PUBLIC_REVIEW_DEGRADATION_NOTICE,
  PUBLIC_TITLE_MAX_LENGTH,
  publicApiErrorResponseSchema,
  publicCreateReviewResponseSchema,
  publicGetReviewResponseSchema,
  wechatAuthResponseSchema,
  type PublicApiErrorCode,
} from "@grc/contracts";

const ARTICLE = {
  title: "示例审校标题",
  body: "这是一篇用于 fixture 联调的正文，需要人工确认审校结果。",
  privacy_notice_version: PUBLIC_PRIVACY_NOTICE_VERSION,
};

function jsonRequest(
  url: string,
  options: {
    method?: string;
    token?: string;
    idempotencyKey?: string;
    body?: unknown;
    requestId?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.idempotencyKey) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  if (options.requestId) {
    headers.set("x-request-id", options.requestId);
  }
  return new Request(url, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function login(code: string): Promise<string> {
  const response = await postWechatAuth(
    jsonRequest("http://localhost/api/v1/auth/wechat", { body: { code } }),
  );
  expect(response.status).toBe(200);
  const payload = wechatAuthResponseSchema.parse(await response.json());
  expect(payload.session_token.length).toBeGreaterThanOrEqual(32);
  expect(JSON.stringify(payload)).not.toMatch(/openid|providerSubject|subject/i);
  return payload.session_token;
}

async function createQueuedReview(
  token: string,
  body: typeof ARTICLE = ARTICLE,
  idempotencyKey = randomUUID(),
) {
  const response = await postReview(
    jsonRequest("http://localhost/api/v1/reviews", {
      token,
      idempotencyKey,
      body,
    }),
  );
  return { response, idempotencyKey };
}

function reviewParams(reviewId: string) {
  return { params: Promise.resolve({ reviewId }) };
}

function findingParams(reviewId: string, findingId: string) {
  return { params: Promise.resolve({ reviewId, findingId }) };
}

async function errorOf(response: Response): Promise<{
  status: number;
  code: PublicApiErrorCode;
}> {
  const payload = publicApiErrorResponseSchema.parse(await response.json());
  return { status: response.status, code: payload.error.code };
}

beforeEach(() => {
  setPublicApiRuntimeForTests(createFixturePublicApiRuntime());
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  resetPublicApiRuntimeForTests();
  vi.restoreAllMocks();
});

describe("public API v0 fixture slice", () => {
  test("happy path: session, create, poll succeeded result, decide, and delete", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const created = await createQueuedReview(token);
    expect(created.response.status).toBe(202);
    const queued = publicCreateReviewResponseSchema.parse(await created.response.json());
    expect(queued.status).toBe("queued");
    expect(queued.poll_after_ms).toBeGreaterThan(0);

    const fetched = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "GET",
        token,
      }),
      reviewParams(queued.review_id),
    );
    expect(fetched.status).toBe(200);
    const snapshot = publicGetReviewResponseSchema.parse(await fetched.json());
    expect(snapshot.review.status).toBe("succeeded");
    expect(snapshot.review.degradation_notice).toBeNull();
    expect(snapshot.review.findings.length).toBeGreaterThan(0);
    const finding = snapshot.review.findings[0]!;

    const decided = await patchFinding(
      jsonRequest(
        `http://localhost/api/v1/reviews/${queued.review_id}/findings/${finding.finding_id}`,
        {
          method: "PATCH",
          token,
          idempotencyKey: randomUUID(),
          body: {
            action: "ignore",
            expected_article_version: snapshot.review.article.version,
            action_id: randomUUID(),
          },
        },
      ),
      findingParams(queued.review_id, finding.finding_id),
    );
    expect(decided.status).toBe(200);
    const afterDecision = publicGetReviewResponseSchema.parse(await decided.json());
    expect(afterDecision.review.findings[0]?.status).toBe("ignored");

    const deleted = await deleteReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "DELETE",
        token,
        idempotencyKey: randomUUID(),
      }),
      reviewParams(queued.review_id),
    );
    expect(deleted.status).toBe(204);

    const missing = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "GET",
        token,
      }),
      reviewParams(queued.review_id),
    );
    expect(await errorOf(missing)).toEqual({ status: 404, code: "REVIEW_NOT_FOUND" });
  });

  test("degraded fixture results keep the frozen caution notice", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const created = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:degraded] 降级标题",
    });
    const queued = publicCreateReviewResponseSchema.parse(await created.response.json());
    const fetched = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "GET",
        token,
      }),
      reviewParams(queued.review_id),
    );
    const snapshot = publicGetReviewResponseSchema.parse(await fetched.json());
    expect(snapshot.review.status).toBe("degraded");
    expect(snapshot.review.findings).toEqual([]);
    expect(snapshot.review.degradation_notice).toBe(PUBLIC_REVIEW_DEGRADATION_NOTICE);
    expect(snapshot.review.status).not.toBe("succeeded");
  });

  test("fixture directives cover running and failed states", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const runningCreated = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:running] 运行中",
    });
    const runningQueued = publicCreateReviewResponseSchema.parse(
      await runningCreated.response.json(),
    );
    const runningFetched = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${runningQueued.review_id}`, {
        method: "GET",
        token,
      }),
      reviewParams(runningQueued.review_id),
    );
    expect(publicGetReviewResponseSchema.parse(await runningFetched.json()).review.status).toBe(
      "running",
    );
    expect(
      (
        await deleteReview(
          jsonRequest(`http://localhost/api/v1/reviews/${runningQueued.review_id}`, {
            method: "DELETE",
            token,
            idempotencyKey: randomUUID(),
          }),
          reviewParams(runningQueued.review_id),
        )
      ).status,
    ).toBe(204);

    const failedCreated = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:failed] 失败稿",
    });
    const failedQueued = publicCreateReviewResponseSchema.parse(
      await failedCreated.response.json(),
    );
    const failedFetched = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${failedQueued.review_id}`, {
        method: "GET",
        token,
      }),
      reviewParams(failedQueued.review_id),
    );
    const failed = publicGetReviewResponseSchema.parse(await failedFetched.json());
    expect(failed.review.status).toBe("failed");
    expect(failed.review.failure_code).toBe("UPSTREAM_UNAVAILABLE");
  });

  test("unauthenticated writes and reads are rejected", async () => {
    const created = await postReview(
      jsonRequest("http://localhost/api/v1/reviews", {
        idempotencyKey: randomUUID(),
        body: ARTICLE,
      }),
    );
    expect(await errorOf(created)).toEqual({ status: 401, code: "AUTH_REQUIRED" });

    const invalid = await getReview(
      jsonRequest("http://localhost/api/v1/reviews/review_missing", {
        method: "GET",
        token: "totally-invalid-token",
      }),
      reviewParams("review_missing"),
    );
    expect(await errorOf(invalid)).toEqual({ status: 401, code: "AUTH_REQUIRED" });
  });

  test("users cannot read, decide, or delete another user's review", async () => {
    const tokenA = await login(FIXTURE_WECHAT_CODES.userA);
    const tokenB = await login(FIXTURE_WECHAT_CODES.userB);
    const created = await createQueuedReview(tokenA);
    const queued = publicCreateReviewResponseSchema.parse(await created.response.json());

    const read = await getReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "GET",
        token: tokenB,
      }),
      reviewParams(queued.review_id),
    );
    expect(await errorOf(read)).toEqual({ status: 404, code: "REVIEW_NOT_FOUND" });

    const decided = await patchFinding(
      jsonRequest(
        `http://localhost/api/v1/reviews/${queued.review_id}/findings/finding_fixture_1`,
        {
          method: "PATCH",
          token: tokenB,
          idempotencyKey: randomUUID(),
          body: {
            action: "ignore",
            expected_article_version: 1,
            action_id: randomUUID(),
          },
        },
      ),
      findingParams(queued.review_id, "finding_fixture_1"),
    );
    expect(await errorOf(decided)).toEqual({ status: 404, code: "REVIEW_NOT_FOUND" });

    const deleted = await deleteReview(
      jsonRequest(`http://localhost/api/v1/reviews/${queued.review_id}`, {
        method: "DELETE",
        token: tokenB,
        idempotencyKey: randomUUID(),
      }),
      reviewParams(queued.review_id),
    );
    expect(await errorOf(deleted)).toEqual({ status: 404, code: "REVIEW_NOT_FOUND" });
  });

  test("idempotent create retries reuse the same review without extra quota", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const key = randomUUID();
    const first = await createQueuedReview(token, ARTICLE, key);
    const second = await createQueuedReview(token, ARTICLE, key);
    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(202);
    const firstBody = publicCreateReviewResponseSchema.parse(await first.response.json());
    const secondBody = publicCreateReviewResponseSchema.parse(await second.response.json());
    expect(secondBody.review_id).toBe(firstBody.review_id);

    const extra = await createQueuedReview(token, { ...ARTICLE, title: "第二篇独立稿件" });
    expect(extra.response.status).toBe(202);
    const extraBody = publicCreateReviewResponseSchema.parse(await extra.response.json());
    expect(extraBody.review_id).not.toBe(firstBody.review_id);
  });

  test("reusing an idempotency key with a different body conflicts", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const key = randomUUID();
    const first = await createQueuedReview(token, ARTICLE, key);
    expect(first.response.status).toBe(202);
    const conflict = await createQueuedReview(
      token,
      { ...ARTICLE, title: "另一篇标题" },
      key,
    );
    expect(await errorOf(conflict.response)).toEqual({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  test("oversize title or body returns ARTICLE_TOO_LARGE", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const title = await createQueuedReview(token, {
      ...ARTICLE,
      title: "标".repeat(PUBLIC_TITLE_MAX_LENGTH + 1),
    });
    expect(await errorOf(title.response)).toEqual({
      status: 413,
      code: "ARTICLE_TOO_LARGE",
    });
    const body = await createQueuedReview(token, {
      ...ARTICLE,
      body: "正".repeat(PUBLIC_BODY_MAX_LENGTH + 1),
    });
    expect(await errorOf(body.response)).toEqual({
      status: 413,
      code: "ARTICLE_TOO_LARGE",
    });
  });

  test("invalid input is rejected with stable client error codes", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);

    const extra = await postReview(
      jsonRequest("http://localhost/api/v1/reviews", {
        token,
        idempotencyKey: randomUUID(),
        body: { ...ARTICLE, user_id: "attacker" },
      }),
    );
    expect(await errorOf(extra)).toEqual({ status: 400, code: "INVALID_REQUEST" });

    const empty = await createQueuedReview(token, { ...ARTICLE, title: "   " });
    expect(await errorOf(empty.response)).toEqual({ status: 400, code: "INVALID_REQUEST" });

    const badKey = await postReview(
      jsonRequest("http://localhost/api/v1/reviews", {
        token,
        idempotencyKey: "not-a-uuid",
        body: ARTICLE,
      }),
    );
    expect(await errorOf(badKey)).toEqual({ status: 400, code: "INVALID_REQUEST" });

    const outdated = await createQueuedReview(token, {
      ...ARTICLE,
      privacy_notice_version: "old-notice",
    });
    expect(await errorOf(outdated.response)).toEqual({
      status: 400,
      code: "PRIVACY_NOTICE_OUTDATED",
    });

    const rejected = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:rejected] 违规标题",
    });
    expect(await errorOf(rejected.response)).toEqual({
      status: 422,
      code: "CONTENT_REJECTED",
    });
  });

  test("daily quota is consumed even after delete", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await createQueuedReview(token, {
        ...ARTICLE,
        title: `额度稿件${index}`,
      });
      expect(created.response.status).toBe(202);
      ids.push(publicCreateReviewResponseSchema.parse(await created.response.json()).review_id);
    }
    const deleted = await deleteReview(
      jsonRequest(`http://localhost/api/v1/reviews/${ids[0]}`, {
        method: "DELETE",
        token,
        idempotencyKey: randomUUID(),
      }),
      reviewParams(ids[0]!),
    );
    expect(deleted.status).toBe(204);
    const exhausted = await createQueuedReview(token, { ...ARTICLE, title: "超额稿件" });
    expect(await errorOf(exhausted.response)).toEqual({
      status: 429,
      code: "DAILY_QUOTA_EXCEEDED",
    });
  });

  test("concurrent queued reviews are limited per user", async () => {
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const first = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:queued] 进行中",
    });
    expect(first.response.status).toBe(202);
    const second = await createQueuedReview(token, {
      ...ARTICLE,
      title: "[fixture:queued] 第二篇进行中",
    });
    expect(await errorOf(second.response)).toEqual({
      status: 409,
      code: "REVIEW_ALREADY_RUNNING",
    });
  });

  test("unconfigured production adapters fail closed", async () => {
    setPublicApiRuntimeForTests(createFailClosedPublicApiRuntime());
    const auth = await postWechatAuth(
      jsonRequest("http://localhost/api/v1/auth/wechat", {
        body: { code: "any-wechat-code" },
      }),
    );
    expect(await errorOf(auth)).toEqual({ status: 503, code: "NOT_IMPLEMENTED" });

    const created = await postReview(
      jsonRequest("http://localhost/api/v1/reviews", {
        token: "a".repeat(32),
        idempotencyKey: randomUUID(),
        body: ARTICLE,
      }),
    );
    expect(await errorOf(created)).toEqual({ status: 503, code: "NOT_IMPLEMENTED" });
  });

  test("logs omit bearer tokens and article bodies", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const token = await login(FIXTURE_WECHAT_CODES.userA);
    const canary = "UNIQUE_ARTICLE_BODY_CANARY_7f3a2b";
    await createQueuedReview(token, { ...ARTICLE, body: canary });
    const serialized = info.mock.calls.map((item) => JSON.stringify(item)).join("\n");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("Bearer ");
  });

  test("production env factory does not silently use fixture success", async () => {
    const previous = process.env.PUBLIC_API_MODE;
    process.env.PUBLIC_API_MODE = "production";
    try {
      const runtime = createPublicApiRuntimeFromEnv();
      await expect(runtime.identityProvider.exchangeCode("fixture-code-a")).rejects.toMatchObject({
        code: "NOT_IMPLEMENTED",
      });
      await expect(runtime.reviews.quotaFor("user_x")).rejects.toMatchObject({
        code: "NOT_IMPLEMENTED",
      });
      await expect(runtime.worker.processEnqueued("review_x")).rejects.toMatchObject({
        code: "NOT_IMPLEMENTED",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PUBLIC_API_MODE;
      } else {
        process.env.PUBLIC_API_MODE = previous;
      }
    }
  });
});
