// Local Public API v0 projection for the mini program.
// Backend owns the shared contract. This file must not be copied into packages/contracts.

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

export const PUBLIC_IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PUBLIC_REVIEW_DEGRADATION_NOTICE =
  "模型审校未完成，本轮仅完成规则检查，不能视为稿件没有问题。";

export type ReviewStatus = (typeof PUBLIC_REVIEW_STATUSES)[number];

export type FindingAction = "accept" | "ignore" | "verify";
export type FindingStatus = "pending" | "accepted" | "ignored" | "verify" | "invalidated";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type PublicApiErrorCode = (typeof PUBLIC_API_ERROR_CODES)[number];

export type ClientTransportErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "TIMEOUT"
  | "EMPTY_RESPONSE"
  | "CONFIG_REQUIRED";

export type SourceSpan = {
  field: "title" | "body";
  start_offset: number;
  end_offset: number;
  quoted_text: string;
  paragraph_index: number;
  article_version: number;
};

export type FindingEvidence = {
  kind: string;
  excerpt: string;
  citation_validated: boolean;
};

export type ReviewFinding = {
  finding_id: string;
  type: string;
  severity: FindingSeverity;
  source_span: SourceSpan;
  title: string;
  reason: string;
  suggestion: {
    text: string;
    replacement: string | null;
  };
  confidence: number;
  evidence: FindingEvidence[];
  status: FindingStatus;
  requires_verification?: boolean;
};

export type ReviewResource = {
  review_id: string;
  status: ReviewStatus;
  article: {
    title: string;
    body: string;
    version: number;
  };
  findings: ReviewFinding[];
  degradation_notice: string | null;
  failure_code: PublicApiErrorCode | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type LoginResult = {
  request_id: string;
  expires_at: string;
  daily_limit: number;
  remaining: number;
  running_limit: number;
};

export type CreateReviewInput = {
  title: string;
  body: string;
  privacy_notice_version: string;
};

export type CreateReviewResult = {
  request_id: string;
  review_id: string;
  status: "queued";
  poll_after_ms: number;
  expires_at: string;
};

export type GetReviewResult = {
  request_id: string;
  review: ReviewResource;
};

export type DecisionInput = {
  action: FindingAction;
  expected_article_version: number;
  action_id: string;
};

export interface ReviewClient {
  login(): Promise<LoginResult>;
  createReview(input: CreateReviewInput): Promise<CreateReviewResult>;
  getReview(reviewId: string): Promise<GetReviewResult>;
  decide(reviewId: string, findingId: string, input: DecisionInput): Promise<GetReviewResult>;
  deleteReview(reviewId: string): Promise<void>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
