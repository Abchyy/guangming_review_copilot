import { DEGRADED_CAUTION, isPublicArticleTooLarge } from "./contract";
import {
  ApiError,
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
  PUBLIC_PRIVACY_NOTICE_VERSION,
  type CreateReviewInput,
  type CreateReviewResult,
  type DecisionInput,
  type GetReviewResult,
  type LoginResult,
  type ReviewClient,
  type ReviewFinding,
  type ReviewResource,
  type ReviewStatus,
} from "./types";

export type FixtureScenario =
  | "success"
  | "degraded"
  | "auth"
  | "forbidden"
  | "conflict"
  | "too-large"
  | "rejected"
  | "quota"
  | "rate-limit"
  | "unavailable"
  | "network"
  | "timeout"
  | "empty"
  | "failed"
  | "expired";

export const FIXTURE_SCENARIOS: FixtureScenario[] = [
  "success",
  "degraded",
  "auth",
  "forbidden",
  "conflict",
  "too-large",
  "rejected",
  "quota",
  "rate-limit",
  "unavailable",
  "network",
  "timeout",
  "empty",
  "failed",
  "expired",
];

const SCENARIO_ERRORS: Partial<Record<FixtureScenario, ApiError>> = {
  auth: new ApiError(401, "AUTH_REQUIRED", "Fixture authentication failure"),
  forbidden: new ApiError(403, "FORBIDDEN", "Fixture ownership failure"),
  conflict: new ApiError(409, "REVIEW_ALREADY_RUNNING", "Fixture concurrency conflict"),
  "too-large": new ApiError(413, "ARTICLE_TOO_LARGE", "Fixture body is too large"),
  rejected: new ApiError(422, "CONTENT_REJECTED", "Fixture content rejection"),
  quota: new ApiError(429, "DAILY_QUOTA_EXCEEDED", "Fixture quota exhausted"),
  "rate-limit": new ApiError(429, "RATE_LIMITED", "Fixture rate limited"),
  unavailable: new ApiError(503, "UPSTREAM_UNAVAILABLE", "Fixture upstream failure"),
  network: new ApiError(0, "NETWORK_UNAVAILABLE", "Fixture network failure"),
};

type StoredReview = {
  review: ReviewResource;
  polls: number;
  deleted: boolean;
  pollAfterMs: number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeFinding(body: string): ReviewFinding {
  const preferred = "已完成了";
  const hasPreferred = body.includes(preferred);
  const start = hasPreferred ? body.indexOf(preferred) : 0;
  const end = hasPreferred ? start + preferred.length : Math.min(body.length, 4);
  const quoted = body.slice(start, end);
  return {
    finding_id: "fixture-finding-1",
    type: "basic_text",
    severity: "medium",
    source_span: {
      field: "body",
      start_offset: start,
      end_offset: end,
      quoted_text: quoted,
      paragraph_index: 0,
      article_version: 1,
    },
    title: hasPreferred ? "存在冗余助词" : "建议人工核对开头表述",
    reason: hasPreferred ? "“完成”后通常不需要再使用“了”。" : "Fixture 用此处演示定位与逐项决策。",
    suggestion: {
      text: hasPreferred ? "删除冗余助词，使表达更简洁。" : "请结合原始信源人工核实。",
      replacement: hasPreferred ? "已完成" : null,
    },
    confidence: hasPreferred ? 0.96 : 0.62,
    evidence: [
      {
        kind: "ai_judgment",
        excerpt: quoted,
        citation_validated: false,
      },
    ],
    status: "pending",
  };
}

function asGetResult(requestId: string, review: ReviewResource): GetReviewResult {
  return {
    request_id: requestId,
    review: clone(review),
  };
}

export function isFixtureScenario(value: string | undefined): value is FixtureScenario {
  return Boolean(value && (FIXTURE_SCENARIOS as string[]).includes(value));
}

export class FixtureReviewClient implements ReviewClient {
  private scenario: FixtureScenario;
  private readonly reviews = new Map<string, StoredReview>();
  private sequence = 0;

  constructor(scenario: FixtureScenario = "success") {
    this.scenario = scenario;
  }

  setScenario(scenario: FixtureScenario): void {
    this.scenario = scenario;
  }

  async login(): Promise<LoginResult> {
    if (this.scenario === "auth" || this.scenario === "network") {
      throw SCENARIO_ERRORS[this.scenario];
    }
    return {
      request_id: "fixture-login-request",
      expires_at: iso(60 * 60 * 1000),
      daily_limit: PUBLIC_DEFAULT_DAILY_LIMIT,
      remaining: this.scenario === "quota" ? 0 : PUBLIC_DEFAULT_DAILY_LIMIT,
      running_limit: PUBLIC_DEFAULT_RUNNING_LIMIT,
    };
  }

  async createReview(input: CreateReviewInput): Promise<CreateReviewResult> {
    const scenarioError = SCENARIO_ERRORS[this.scenario];
    if (scenarioError) {
      throw scenarioError;
    }
    if (!input.privacy_notice_version?.trim()) {
      throw new ApiError(400, "INVALID_REQUEST", "Privacy notice version is required");
    }
    if (input.privacy_notice_version.trim() !== PUBLIC_PRIVACY_NOTICE_VERSION) {
      throw new ApiError(400, "PRIVACY_NOTICE_OUTDATED", "The accepted privacy notice version is no longer current");
    }
    if (!input.title.trim() || !input.body.trim()) {
      throw new ApiError(400, "INVALID_REQUEST", "Title and body are required");
    }
    if (isPublicArticleTooLarge(input.title, input.body)) {
      throw new ApiError(413, "ARTICLE_TOO_LARGE", "Fixture body is too large");
    }
    this.sequence += 1;
    const now = iso();
    const reviewId = `fixture-review-${this.sequence}`;
    const review: ReviewResource = {
      review_id: reviewId,
      status: "queued",
      article: { title: input.title, body: input.body, version: 1 },
      findings: [],
      degradation_notice: null,
      failure_code: null,
      created_at: now,
      updated_at: now,
      expires_at: iso(24 * 60 * 60 * 1000),
    };
    this.reviews.set(reviewId, {
      review,
      polls: 0,
      deleted: false,
      pollAfterMs: 120,
    });
    return {
      request_id: `fixture-create-${this.sequence}`,
      review_id: reviewId,
      status: "queued",
      poll_after_ms: 120,
      expires_at: review.expires_at,
    };
  }

  async getReview(reviewId: string): Promise<GetReviewResult> {
    if (this.scenario === "timeout") {
      throw new ApiError(0, "TIMEOUT", "Fixture request timed out");
    }
    if (this.scenario === "empty") {
      throw new ApiError(0, "EMPTY_RESPONSE", "Fixture returned an empty response");
    }
    const stored = this.requireReview(reviewId);
    stored.polls += 1;
    stored.review.updated_at = iso();
    if (stored.polls === 1) {
      stored.review.status = "running";
    } else {
      stored.review.status = this.terminalStatus();
      this.applyTerminalPayload(stored.review);
    }
    return asGetResult(`fixture-poll-${stored.polls}`, stored.review);
  }

  async decide(
    reviewId: string,
    findingId: string,
    input: DecisionInput,
  ): Promise<GetReviewResult> {
    const stored = this.requireReview(reviewId);
    if (input.expected_article_version !== stored.review.article.version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Article version mismatch");
    }
    const finding = stored.review.findings.find((item) => item.finding_id === findingId);
    if (!finding) {
      throw new ApiError(404, "FINDING_NOT_FOUND", "Finding was not found");
    }
    if (input.action === "accept") {
      const replacement = finding.suggestion.replacement;
      if (replacement === null) {
        throw new ApiError(409, "VERSION_CONFLICT", "Finding has no safe replacement");
      }
      const { start_offset: start, end_offset: end } = finding.source_span;
      stored.review.article.body =
        stored.review.article.body.slice(0, start) +
        replacement +
        stored.review.article.body.slice(end);
      stored.review.article.version += 1;
      finding.status = "accepted";
      finding.source_span.article_version = stored.review.article.version;
      finding.source_span.end_offset = start + replacement.length;
      finding.source_span.quoted_text = replacement;
    } else {
      finding.status = input.action === "ignore" ? "ignored" : "verify";
    }
    stored.review.updated_at = iso();
    return asGetResult(`fixture-action-${input.action_id}`, stored.review);
  }

  async deleteReview(reviewId: string): Promise<void> {
    const stored = this.requireReview(reviewId);
    stored.deleted = true;
    stored.review.article.title = "";
    stored.review.article.body = "";
    stored.review.findings = [];
    stored.review.status = "cancelled";
  }

  getStored(reviewId: string): ReviewResource | null {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted) {
      return null;
    }
    return clone(stored.review);
  }

  private terminalStatus(): ReviewStatus {
    if (this.scenario === "degraded") {
      return "degraded";
    }
    if (this.scenario === "failed") {
      return "failed";
    }
    if (this.scenario === "expired") {
      return "expired";
    }
    return "succeeded";
  }

  private applyTerminalPayload(review: ReviewResource): void {
    if (review.status === "degraded") {
      review.findings = [];
      review.degradation_notice = DEGRADED_CAUTION;
      review.failure_code = null;
      return;
    }
    if (review.status === "failed") {
      review.findings = [];
      review.degradation_notice = null;
      review.failure_code = "UPSTREAM_UNAVAILABLE";
      return;
    }
    if (review.status === "expired") {
      review.findings = [];
      review.degradation_notice = null;
      review.failure_code = null;
      return;
    }
    review.findings = [makeFinding(review.article.body)];
    review.degradation_notice = null;
    review.failure_code = null;
  }

  private requireReview(reviewId: string): StoredReview {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted) {
      throw new ApiError(404, "REVIEW_NOT_FOUND", "Review was not found");
    }
    return stored;
  }
}
