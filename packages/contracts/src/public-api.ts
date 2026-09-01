import { z } from "zod";

import { FINDING_ACTIONS, findingSchema } from "./review";

export const PUBLIC_TITLE_MAX_LENGTH = 200;
export const PUBLIC_BODY_MAX_LENGTH = 10_000;
export const PUBLIC_DEFAULT_DAILY_LIMIT = 3;
export const PUBLIC_DEFAULT_RUNNING_LIMIT = 1;
export const PUBLIC_DEFAULT_POLL_AFTER_MS = 1_000;
export const PUBLIC_PRIVACY_NOTICE_VERSION = "public-v1";

export const PUBLIC_REVIEW_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "degraded",
  "failed",
  "cancelled",
  "expired",
] as const;

export const PUBLIC_API_ERROR_CODES = [
  "INVALID_REQUEST",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "REVIEW_NOT_FOUND",
  "FINDING_NOT_FOUND",
  "VERSION_CONFLICT",
  "REVIEW_ALREADY_RUNNING",
  "IDEMPOTENCY_CONFLICT",
  "PRIVACY_NOTICE_OUTDATED",
  "ARTICLE_TOO_LARGE",
  "CONTENT_REJECTED",
  "DAILY_QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "REVIEW_CAPACITY_EXHAUSTED",
  "UPSTREAM_UNAVAILABLE",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
] as const;

export const PUBLIC_API_ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  REVIEW_NOT_FOUND: 404,
  FINDING_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  REVIEW_ALREADY_RUNNING: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PRIVACY_NOTICE_OUTDATED: 400,
  ARTICLE_TOO_LARGE: 413,
  CONTENT_REJECTED: 422,
  DAILY_QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  REVIEW_CAPACITY_EXHAUSTED: 503,
  UPSTREAM_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 503,
  INTERNAL_ERROR: 500,
} as const;

export const PUBLIC_REVIEW_DEGRADATION_NOTICE =
  "模型审校未完成，本轮仅完成规则检查，不能视为稿件没有问题。";

export const publicReviewStatusSchema = z.enum(PUBLIC_REVIEW_STATUSES);
export const publicApiErrorCodeSchema = z.enum(PUBLIC_API_ERROR_CODES);

export const publicIdempotencyKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Idempotency-Key must be a UUID",
  );

export const publicApiErrorResponseSchema = z.object({
  request_id: z.string().min(1),
  error: z.object({
    code: publicApiErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const wechatAuthRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(256),
  })
  .strict();

export const wechatAuthResponseSchema = z.object({
  request_id: z.string().min(1),
  session_token: z.string().min(32),
  expires_at: z.string().min(1),
  daily_limit: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
  running_limit: z.number().int().positive(),
});

export const publicCreateReviewRequestSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    privacy_notice_version: z.string().trim().min(1).max(64),
  })
  .strict();

export const publicCreateReviewResponseSchema = z.object({
  request_id: z.string().min(1),
  review_id: z.string().min(1),
  status: z.literal("queued"),
  poll_after_ms: z.number().int().positive(),
  expires_at: z.string().min(1),
});

export const publicReviewResourceSchema = z
  .object({
    review_id: z.string().min(1),
    status: publicReviewStatusSchema,
    article: z.object({
      title: z.string(),
      body: z.string(),
      version: z.number().int().positive(),
    }),
    findings: z.array(findingSchema),
    degradation_notice: z.string().min(1).nullable(),
    failure_code: publicApiErrorCodeSchema.nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    expires_at: z.string().min(1),
  })
  .superRefine((review, context) => {
    if (
      review.status === "degraded" &&
      review.degradation_notice !== PUBLIC_REVIEW_DEGRADATION_NOTICE
    ) {
      context.addIssue({
        code: "custom",
        path: ["degradation_notice"],
        message: "degraded reviews must include the frozen caution notice",
      });
    }
    if (review.status !== "degraded" && review.degradation_notice !== null) {
      context.addIssue({
        code: "custom",
        path: ["degradation_notice"],
        message: "only degraded reviews may include a degradation notice",
      });
    }
    if (review.status === "failed" && review.failure_code === null) {
      context.addIssue({
        code: "custom",
        path: ["failure_code"],
        message: "failed reviews must include a failure code",
      });
    }
    if (review.status !== "failed" && review.failure_code !== null) {
      context.addIssue({
        code: "custom",
        path: ["failure_code"],
        message: "only failed reviews may include a failure code",
      });
    }
  });

export const publicGetReviewResponseSchema = z.object({
  request_id: z.string().min(1),
  review: publicReviewResourceSchema,
});

export const publicFindingDecisionRequestSchema = z
  .object({
    action: z.enum(FINDING_ACTIONS),
    expected_article_version: z.number().int().positive(),
    action_id: z.string().trim().min(1).max(128),
  })
  .strict();

export const publicFindingDecisionResponseSchema = publicGetReviewResponseSchema;

export type PublicReviewStatus = z.infer<typeof publicReviewStatusSchema>;
export type PublicApiErrorCode = z.infer<typeof publicApiErrorCodeSchema>;
export type PublicApiErrorResponse = z.infer<typeof publicApiErrorResponseSchema>;
export type PublicIdempotencyKey = z.infer<typeof publicIdempotencyKeySchema>;
export type WechatAuthRequest = z.infer<typeof wechatAuthRequestSchema>;
export type WechatAuthResponse = z.infer<typeof wechatAuthResponseSchema>;
export type PublicCreateReviewRequest = z.infer<
  typeof publicCreateReviewRequestSchema
>;
export type PublicCreateReviewResponse = z.infer<
  typeof publicCreateReviewResponseSchema
>;
export type PublicReviewResource = z.infer<typeof publicReviewResourceSchema>;
export type PublicGetReviewResponse = z.infer<typeof publicGetReviewResponseSchema>;
export type PublicFindingDecisionRequest = z.infer<
  typeof publicFindingDecisionRequestSchema
>;
export type PublicFindingDecisionResponse = z.infer<
  typeof publicFindingDecisionResponseSchema
>;

export function utf16Length(value: string): number {
  return value.length;
}

export function isPublicArticleTooLarge(title: string, body: string): boolean {
  return (
    utf16Length(title) > PUBLIC_TITLE_MAX_LENGTH ||
    utf16Length(body) > PUBLIC_BODY_MAX_LENGTH
  );
}
