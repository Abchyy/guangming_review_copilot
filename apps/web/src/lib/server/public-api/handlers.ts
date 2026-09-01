import {
  isPublicArticleTooLarge,
  publicCreateReviewRequestSchema,
  publicCreateReviewResponseSchema,
  publicFindingDecisionRequestSchema,
  publicGetReviewResponseSchema,
  wechatAuthRequestSchema,
  wechatAuthResponseSchema,
} from "@grc/contracts";

import { PublicApiError } from "./errors";
import { hasForbiddenControlChars } from "./in-memory";
import {
  publicJson,
  publicNoContent,
  readIdempotencyKey,
  readJsonBody,
  requirePrincipal,
  withPublicApi,
} from "./http";
import type { PublicApiRuntime } from "./types";

function invalidRequest(message: string): never {
  throw new PublicApiError("INVALID_REQUEST", message);
}

export function handleWechatAuth(runtime: PublicApiRuntime) {
  return async function POST(request: Request): Promise<Response> {
    return withPublicApi(request, runtime, "/api/v1/auth/wechat", async ({ requestId }) => {
      const json = await readJsonBody(request);
      const parsed = wechatAuthRequestSchema.safeParse(json);
      if (!parsed.success) invalidRequest("code is required");

      const identity = await runtime.identityProvider.exchangeCode(parsed.data.code);
      const session = await runtime.sessions.createSession(identity);
      const quota = await runtime.reviews.quotaFor(session.principal.userId);
      const body = wechatAuthResponseSchema.parse({
        request_id: requestId,
        session_token: session.token,
        expires_at: session.expiresAt,
        daily_limit: quota.dailyLimit,
        remaining: quota.remaining,
        running_limit: quota.runningLimit,
      });
      return publicJson(200, requestId, body);
    });
  };
}

export function handleCreateReview(runtime: PublicApiRuntime) {
  return async function POST(request: Request): Promise<Response> {
    return withPublicApi(request, runtime, "/api/v1/reviews", async ({ requestId }) => {
      const principal = await requirePrincipal(request, runtime);
      const idempotencyKey = readIdempotencyKey(request);
      const json = await readJsonBody(request);
      const parsed = publicCreateReviewRequestSchema.safeParse(json);
      if (!parsed.success) invalidRequest("title, body, and privacy_notice_version are required");

      if (isPublicArticleTooLarge(parsed.data.title, parsed.data.body)) {
        throw new PublicApiError("ARTICLE_TOO_LARGE", "Title or body exceeds the public limit");
      }

      const title = parsed.data.title.trim();
      const body = parsed.data.body.trim();
      if (!title || !body) invalidRequest("title and body must be non-empty");

      if (hasForbiddenControlChars(parsed.data.title) || hasForbiddenControlChars(parsed.data.body)) {
        throw new PublicApiError("CONTENT_REJECTED", "Article content was rejected");
      }

      const enqueued = await runtime.reviews.enqueueReview({
        ownerId: principal.userId,
        idempotencyKey,
        review: {
          title,
          body,
          privacy_notice_version: parsed.data.privacy_notice_version,
        },
      });
      try {
        await runtime.worker.processEnqueued(enqueued.reviewId);
      } catch (error) {
        if (!(error instanceof PublicApiError) || error.code !== "NOT_IMPLEMENTED") {
          throw error;
        }
      }

      const response = publicCreateReviewResponseSchema.parse({
        request_id: requestId,
        review_id: enqueued.reviewId,
        status: "queued",
        poll_after_ms: enqueued.pollAfterMs,
        expires_at: enqueued.expiresAt,
      });
      return publicJson(202, requestId, response);
    });
  };
}

export function handleGetReview(runtime: PublicApiRuntime) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ reviewId: string }> },
  ): Promise<Response> {
    return withPublicApi(request, runtime, "/api/v1/reviews/{review_id}", async ({ requestId }) => {
      const principal = await requirePrincipal(request, runtime);
      const { reviewId } = await context.params;
      const review = await runtime.reviews.getOwnedReview(principal.userId, reviewId);
      if (!review) {
        throw new PublicApiError("REVIEW_NOT_FOUND", "Review not found");
      }
      const body = publicGetReviewResponseSchema.parse({
        request_id: requestId,
        review,
      });
      return publicJson(200, requestId, body);
    });
  };
}

export function handleDeleteReview(runtime: PublicApiRuntime) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ reviewId: string }> },
  ): Promise<Response> {
    return withPublicApi(request, runtime, "/api/v1/reviews/{review_id}", async ({ requestId }) => {
      const principal = await requirePrincipal(request, runtime);
      const idempotencyKey = readIdempotencyKey(request);
      const { reviewId } = await context.params;
      const deleted = await runtime.reviews.deleteOwnedReview(
        principal.userId,
        reviewId,
        idempotencyKey,
      );
      if (!deleted) {
        throw new PublicApiError("REVIEW_NOT_FOUND", "Review not found");
      }
      return publicNoContent(requestId);
    });
  };
}

export function handleFindingDecision(runtime: PublicApiRuntime) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ reviewId: string; findingId: string }> },
  ): Promise<Response> {
    return withPublicApi(
      request,
      runtime,
      "/api/v1/reviews/{review_id}/findings/{finding_id}",
      async ({ requestId }) => {
        const principal = await requirePrincipal(request, runtime);
        const idempotencyKey = readIdempotencyKey(request);
        const { reviewId, findingId } = await context.params;
        const json = await readJsonBody(request);
        const parsed = publicFindingDecisionRequestSchema.safeParse(json);
        if (!parsed.success) {
          invalidRequest("action, expected_article_version, and action_id are required");
        }

        const review = await runtime.reviews.decideFinding({
          ownerId: principal.userId,
          reviewId,
          findingId,
          idempotencyKey,
          decision: parsed.data,
        });
        const body = publicGetReviewResponseSchema.parse({
          request_id: requestId,
          review,
        });
        return publicJson(200, requestId, body);
      },
    );
  };
}
