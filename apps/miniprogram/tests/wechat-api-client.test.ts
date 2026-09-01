import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPublicIdempotencyKey } from "../services/contract";
import { WechatApiClient } from "../services/wechat-api-client";
import { ApiError, PUBLIC_PRIVACY_NOTICE_VERSION } from "../services/types";

type RequestCall = {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  success: (response: { statusCode: number; data: unknown; header: Record<string, string> }) => void;
  fail: (error: { errMsg: string }) => void;
};

function installWx(queue: Array<(call: RequestCall) => void>, loginCode = "wx-code") {
  const requests: RequestCall[] = [];
  const mock = {
    login(options: { success: (result: { code: string }) => void; fail: (error: { errMsg: string }) => void }) {
      if (!loginCode) {
        options.fail({ errMsg: "login:fail" });
        return;
      }
      options.success({ code: loginCode });
    },
    request(options: RequestCall) {
      requests.push(options);
      const handler = queue.shift();
      if (!handler) {
        options.fail({ errMsg: "request:fail no handler" });
        return;
      }
      handler(options);
    },
    showToast() {},
    showModal() {},
  };
  (globalThis as { wx?: unknown }).wx = mock;
  return requests;
}

const reviewEnvelope = {
  request_id: "get-1",
  review: {
    review_id: "rev-1",
    status: "succeeded",
    article: { title: "标题", body: "正文", version: 1 },
    findings: [],
    degradation_notice: null,
    failure_code: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
  },
};

describe("WechatApiClient adapter boundary", () => {
  it("refuses missing or non-HTTPS API hosts without calling wx.login", async () => {
    let loginCalled = false;
    (globalThis as { wx?: unknown }).wx = {
      login() {
        loginCalled = true;
      },
      request() {},
      showToast() {},
      showModal() {},
    };
    const client = new WechatApiClient("");
    await assert.rejects(() => client.login(), (error: unknown) => {
      assert.equal((error as ApiError).code, "CONFIG_REQUIRED");
      return true;
    });
    const http = new WechatApiClient("http://example.invalid");
    await assert.rejects(() => http.login(), (error: unknown) => {
      assert.equal((error as ApiError).code, "CONFIG_REQUIRED");
      return true;
    });
    assert.equal(loginCalled, false);
  });

  it("exchanges wx.login code, unwraps review envelopes, and sends bearer plus idempotency headers", async () => {
    const requests = installWx([
      (call) => {
        call.success({
          statusCode: 200,
          header: {},
          data: {
            request_id: "login-1",
            session_token: "session-token-value-32chars-min",
            expires_at: "2026-09-01T01:00:00.000Z",
            daily_limit: 3,
            remaining: 2,
            running_limit: 1,
          },
        });
      },
      (call) => {
        call.success({
          statusCode: 202,
          header: {},
          data: {
            request_id: "create-1",
            review_id: "rev-1",
            status: "queued",
            poll_after_ms: 50,
            expires_at: "2026-09-02T00:00:00.000Z",
          },
        });
      },
      (call) => {
        call.success({ statusCode: 200, header: {}, data: reviewEnvelope });
      },
      (call) => {
        call.success({ statusCode: 204, header: {}, data: "" });
      },
    ]);
    const client = new WechatApiClient("https://api.example.invalid");
    const login = await client.login();
    assert.equal(login.remaining, 2);
    assert.equal("session_token" in login, false);
    const created = await client.createReview({
      title: "标题",
      body: "正文",
      privacy_notice_version: PUBLIC_PRIVACY_NOTICE_VERSION,
    });
    assert.equal(created.status, "queued");
    const got = await client.getReview("rev-1");
    assert.equal(got.review.review_id, "rev-1");
    await client.deleteReview("rev-1");
    assert.match(requests[0]?.url ?? "", /\/api\/v1\/auth\/wechat$/);
    assert.equal((requests[0]?.data as { code: string }).code, "wx-code");
    assert.match(requests[1]?.header?.Authorization ?? "", /Bearer session-token-value-32chars-min/);
    assert.equal(isPublicIdempotencyKey(requests[1]?.header?.["Idempotency-Key"] ?? ""), true);
    assert.equal(requests[3]?.method, "DELETE");
  });

  it("parses backend error envelopes and empty/timeout transport failures", async () => {
    installWx([
      (call) => {
        call.success({
          statusCode: 200,
          header: {},
          data: {
            request_id: "login-1",
            session_token: "session-token-value-32chars-min",
            expires_at: "2026-09-01T01:00:00.000Z",
            daily_limit: 3,
            remaining: 3,
            running_limit: 1,
          },
        });
      },
      (call) => {
        call.success({
          statusCode: 401,
          header: {},
          data: { request_id: "e1", error: { code: "AUTH_REQUIRED", message: "expired" } },
        });
      },
    ]);
    const client = new WechatApiClient("https://api.example.invalid");
    await client.login();
    await assert.rejects(() => client.createReview({ title: "t", body: "b", privacy_notice_version: "v" }), (error: unknown) => {
      assert.equal((error as ApiError).status, 401);
      assert.equal((error as ApiError).code, "AUTH_REQUIRED");
      return true;
    });

    installWx([
      (call) => {
        call.success({
          statusCode: 200,
          header: {},
          data: {
            request_id: "login-1",
            session_token: "session-token-value-32chars-min",
            expires_at: "2026-09-01T01:00:00.000Z",
            daily_limit: 3,
            remaining: 3,
            running_limit: 1,
          },
        });
      },
      (call) => {
        call.success({ statusCode: 200, header: {}, data: "" });
      },
    ]);
    const emptyClient = new WechatApiClient("https://api.example.invalid");
    await emptyClient.login();
    await assert.rejects(() => emptyClient.getReview("rev-1"), (error: unknown) => {
      assert.equal((error as ApiError).code, "EMPTY_RESPONSE");
      return true;
    });

    installWx([
      (call) => {
        call.success({
          statusCode: 200,
          header: {},
          data: {
            request_id: "login-1",
            session_token: "session-token-value-32chars-min",
            expires_at: "2026-09-01T01:00:00.000Z",
            daily_limit: 3,
            remaining: 3,
            running_limit: 1,
          },
        });
      },
      (call) => {
        call.fail({ errMsg: "request:fail timeout" });
      },
    ]);
    const timeoutClient = new WechatApiClient("https://api.example.invalid");
    await timeoutClient.login();
    await assert.rejects(() => timeoutClient.getReview("rev-1"), (error: unknown) => {
      assert.equal((error as ApiError).code, "TIMEOUT");
      return true;
    });
  });
});
