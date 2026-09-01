import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BODY_MAX_LENGTH,
  DEGRADED_CAUTION,
  TITLE_MAX_LENGTH,
  buildArticleSegments,
  createIdempotencyKey,
  isPublicArticleTooLarge,
  isPublicIdempotencyKey,
  parseApiError,
  resultPresentation,
  toUserError,
  validateReviewInput,
} from "../services/contract";
import {
  ApiError,
  PUBLIC_API_ERROR_CODES,
  PUBLIC_API_ERROR_HTTP_STATUS,
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
  PUBLIC_PRIVACY_NOTICE_VERSION,
  PUBLIC_REVIEW_DEGRADATION_NOTICE,
  type ReviewResource,
} from "../services/types";

function review(overrides: Partial<ReviewResource> = {}): ReviewResource {
  return {
    review_id: "review-1",
    status: "succeeded",
    article: { title: "标题", body: "正文已完成了检查。", version: 1 },
    findings: [],
    degradation_notice: null,
    failure_code: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("public API v0 freeze", () => {
  it("matches backend public-api constants", () => {
    assert.equal(PUBLIC_PRIVACY_NOTICE_VERSION, "public-v1");
    assert.equal(TITLE_MAX_LENGTH, 200);
    assert.equal(BODY_MAX_LENGTH, 10_000);
    assert.equal(PUBLIC_DEFAULT_DAILY_LIMIT, 3);
    assert.equal(PUBLIC_DEFAULT_RUNNING_LIMIT, 1);
    assert.equal(PUBLIC_DEFAULT_POLL_AFTER_MS, 1_000);
    assert.equal(
      PUBLIC_REVIEW_DEGRADATION_NOTICE,
      "模型审校未完成，本轮仅完成规则检查，不能视为稿件没有问题。",
    );
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.AUTH_REQUIRED, 401);
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.PRIVACY_NOTICE_OUTDATED, 400);
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.ARTICLE_TOO_LARGE, 413);
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.CONTENT_REJECTED, 422);
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.DAILY_QUOTA_EXCEEDED, 429);
    assert.equal(PUBLIC_API_ERROR_HTTP_STATUS.NOT_IMPLEMENTED, 503);
    assert.equal(PUBLIC_API_ERROR_CODES.includes("PRIVACY_NOTICE_OUTDATED"), true);
    assert.equal(isPublicArticleTooLarge("标".repeat(200), "正".repeat(10_000)), false);
    assert.equal(isPublicArticleTooLarge("标".repeat(201), "正文"), true);
    assert.equal(isPublicIdempotencyKey(createIdempotencyKey()), true);
  });
});

describe("input validation", () => {
  it("requires title and body and enforces public v1 limits", () => {
    assert.equal(validateReviewInput("", "正文"), "请填写稿件标题。");
    assert.equal(validateReviewInput("标题", "   "), "请粘贴需要审校的正文。");
    assert.equal(validateReviewInput("标".repeat(201), "正文")?.includes("200"), true);
    assert.equal(validateReviewInput("标题", "正".repeat(10_001))?.includes("10000"), true);
    assert.equal(validateReviewInput("标题", "正文"), null);
  });
});

describe("result presentation", () => {
  it("does not treat degraded, failed, expired, or empty upstream states as clean success", () => {
    const degraded = resultPresentation(
      review({ status: "degraded", degradation_notice: DEGRADED_CAUTION, findings: [] }),
    );
    assert.equal(degraded.kind, "degraded");
    assert.equal(degraded.caution, true);
    assert.equal(degraded.detail, DEGRADED_CAUTION);
    assert.notEqual(degraded.kind, "empty-success");

    const failed = resultPresentation(review({ status: "failed", failure_code: "UPSTREAM_UNAVAILABLE" }));
    assert.equal(failed.kind, "failed");
    assert.match(failed.detail, /不能视为稿件没有问题/);

    const expired = resultPresentation(review({ status: "expired" }));
    assert.equal(expired.kind, "expired");
    assert.match(expired.detail, /不能视为稿件没有问题/);
  });

  it("uses a non-absolute empty copy only for succeeded reviews with no findings", () => {
    const empty = resultPresentation(review({ findings: [] }));
    assert.equal(empty.kind, "empty-success");
    assert.equal(empty.caution, false);
    assert.match(empty.detail, /不能替代人工复核/);
    assert.doesNotMatch(empty.title, /稿件无问题|没有问题/);
  });
});

describe("article segments", () => {
  it("highlights pending body spans", () => {
    const body = "日前已完成了专项检查。";
    const start = body.indexOf("已完成了");
    const segments = buildArticleSegments(body, [
      {
        finding_id: "f1",
        type: "basic_text",
        severity: "medium",
        source_span: {
          field: "body",
          start_offset: start,
          end_offset: start + 4,
          quoted_text: "已完成了",
          paragraph_index: 0,
          article_version: 1,
        },
        title: "冗余助词",
        reason: "测试",
        suggestion: { text: "删除了", replacement: "已完成" },
        confidence: 0.9,
        evidence: [],
        status: "pending",
      },
    ]);
    assert.equal(segments.some((segment) => segment.highlight && segment.findingId === "f1"), true);
  });
});

describe("error mapping", () => {
  it("maps backend error envelopes and local transport failures", () => {
    const parsed = parseApiError(401, {
      request_id: "r1",
      error: { code: "AUTH_REQUIRED", message: "no" },
    });
    assert.equal(parsed.code, "AUTH_REQUIRED");
    assert.equal(toUserError(parsed).message, "登录状态已失效，请重新发起审校。");
    assert.equal(toUserError(new ApiError(0, "TIMEOUT", "timeout")).message.includes("不能视为稿件没有问题"), true);
    assert.equal(
      toUserError(new ApiError(0, "EMPTY_RESPONSE", "empty")).message.includes("不能视为稿件没有问题"),
      true,
    );
    assert.equal(toUserError(new ApiError(0, "NETWORK_UNAVAILABLE", "net")).code, "NETWORK_UNAVAILABLE");
  });
});
