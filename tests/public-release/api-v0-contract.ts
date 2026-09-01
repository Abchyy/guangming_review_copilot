import { z } from "zod";

import contractSpec from "../fixtures/public-api/contract/api-v0.json";

export const EVIDENCE_CLASSES = [
  "FIXTURE_VERIFIED",
  "STATIC_CHECK",
  "NOT_VERIFIED",
  "BLOCKED_EXTERNAL",
] as const;

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const PRODUCT_WORKING_NAME = "AI 审校助手";

export const PUBLIC_API_BASE_PATH = "/api/v1";

export const REVIEW_STATUSES = contractSpec.review_statuses;

export const DEGRADED_CAUTION = contractSpec.degraded_caution;

export const TITLE_MAX_UTF16 = contractSpec.limits.title_max_utf16;
export const BODY_MAX_UTF16 = contractSpec.limits.body_max_utf16;
export const DECLARED_TTL_HOURS = contractSpec.ttl.declared_retention_hours;
export const PRIVACY_NOTICE_VERSION = contractSpec.privacy_notice_version;

export const STABLE_ERROR_CODES = contractSpec.error_codes.map((item) => item.code);

export const ERROR_CODE_HTTP = new Map(
  contractSpec.error_codes.map((item) => [item.code, item.http] as const),
);

const FORBIDDEN_RESPONSE_KEYS = new Set(
  contractSpec.forbidden_response_fields.map((key) => key.toLowerCase()),
);

export const SUCCESS_EMPTY_CLAIM = "没有问题";

const requestIdSchema = z.string().min(1);
const isoTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);
const errorCodeSchema = z.enum(STABLE_ERROR_CODES as [string, ...string[]]);

const errorBodySchema = z
  .object({
    request_id: requestIdSchema,
    error: z.object({
      code: errorCodeSchema,
      message: z.string().min(1),
    }),
  })
  .strict();

const articleSchema = z.object({
  title: z.string(),
  body: z.string(),
  version: z.number().int().positive(),
});

const sourceSpanSchema = z
  .object({
    field: z.enum(["title", "body"]),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
    quoted_text: z.string().min(1),
    paragraph_index: z.number().int().nonnegative(),
    article_version: z.number().int().positive(),
  })
  .refine((span) => span.end_offset >= span.start_offset, {
    message: "end_offset must be >= start_offset",
  });

const findingSchema = z.object({
  finding_id: z.string().min(1),
  type: z.enum([
    "basic_text",
    "person",
    "organization",
    "datetime",
    "number",
    "policy",
    "citation",
    "consistency",
    "external_fact",
  ]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1),
  reason: z.string().min(1),
  status: z.enum(["pending", "accepted", "ignored", "verify", "invalidated"]),
  requires_verification: z.boolean().optional(),
  suggestion: z.object({
    text: z.string(),
    replacement: z.string().nullable(),
  }),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      kind: z.string().min(1),
      excerpt: z.string(),
      citation_validated: z.boolean(),
    }),
  ),
  source_span: sourceSpanSchema,
});

export const loginSuccessSchema = z
  .object({
    request_id: requestIdSchema,
    session_token: z.string().min(32),
    expires_at: isoTimeSchema,
    daily_limit: z.number().int().positive(),
    remaining: z.number().int().nonnegative(),
    running_limit: z.number().int().positive(),
  })
  .strict();

export const createAcceptedSchema = z
  .object({
    request_id: requestIdSchema,
    review_id: z.string().min(1),
    status: z.literal("queued"),
    poll_after_ms: z.number().int().positive(),
    expires_at: isoTimeSchema,
  })
  .strict();

export const publicReviewResourceSchema = z
  .object({
    review_id: z.string().min(1),
    status: z.enum(REVIEW_STATUSES as [string, ...string[]]),
    article: articleSchema,
    findings: z.array(findingSchema),
    degradation_notice: z.string().min(1).nullable(),
    failure_code: errorCodeSchema.nullable(),
    created_at: isoTimeSchema,
    updated_at: isoTimeSchema,
    expires_at: isoTimeSchema,
  })
  .strict()
  .superRefine((review, context) => {
    if (review.status === "degraded" && review.degradation_notice !== DEGRADED_CAUTION) {
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

export const getReviewResponseSchema = z
  .object({
    request_id: requestIdSchema,
    review: publicReviewResourceSchema,
  })
  .strict();

export type PublicHttpExchange = {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

export function assertNoInternalLeakage(payload: unknown, options?: { allowSessionToken?: boolean }): void {
  const keys = collectKeys(payload).map((key) => key.toLowerCase());
  for (const key of keys) {
    if (FORBIDDEN_RESPONSE_KEYS.has(key) && !(options?.allowSessionToken && key === "session_token")) {
      throw new Error(`Public API payload contains forbidden field: ${key}`);
    }
  }
  const text = JSON.stringify(payload);
  if (/"stack"\s*:/i.test(text) || /\bat\s+\S+\s+\([^)]+:\d+:\d+\)/.test(text)) {
    throw new Error("Public API payload appears to contain a stack trace");
  }
  if (/\bsk-[A-Za-z0-9]{8,}\b/.test(text) || /\btvly-[A-Za-z0-9]{8,}\b/.test(text)) {
    throw new Error("Public API payload appears to contain a provider credential");
  }
  if (/\b(appsecret|api[_-]?key)\b\s*[:=]/i.test(text)) {
    throw new Error("Public API payload appears to contain a credential assignment");
  }
}

export function assertNoSuccessEmptyClaim(payload: unknown): void {
  const text = JSON.stringify(payload).split(DEGRADED_CAUTION).join("");
  if (text.includes(SUCCESS_EMPTY_CLAIM)) {
    throw new Error(`Public API payload must not claim “${SUCCESS_EMPTY_CLAIM}”`);
  }
}

export function assertFindingSpansMatchArticle(
  article: { title: string; body: string },
  findings: Array<{ source_span: z.infer<typeof sourceSpanSchema> }>,
): void {
  for (const finding of findings) {
    const text = finding.source_span.field === "title" ? article.title : article.body;
    const sliced = text.slice(finding.source_span.start_offset, finding.source_span.end_offset);
    if (sliced !== finding.source_span.quoted_text) {
      throw new Error(
        `source_span quoted_text does not match article slice: ${JSON.stringify({
          expected: finding.source_span.quoted_text,
          actual: sliced,
        })}`,
      );
    }
  }
}

function assertDeclaredTtl(review: z.infer<typeof publicReviewResourceSchema>): void {
  const created = Date.parse(review.created_at);
  const expires = Date.parse(review.expires_at);
  const hours = (expires - created) / 3_600_000;
  if (Number.isFinite(hours) && hours !== DECLARED_TTL_HOURS) {
    throw new Error(`Fixture expires_at must declare the 24h TTL contract, observed ${hours}h`);
  }
}

function parseReviewEnvelope(body: unknown): z.infer<typeof getReviewResponseSchema> {
  const parsed = getReviewResponseSchema.parse(body);
  assertNoInternalLeakage(parsed);
  if (parsed.review.status === "degraded" || parsed.review.status === "failed") {
    assertNoSuccessEmptyClaim(parsed);
  }
  assertFindingSpansMatchArticle(parsed.review.article, parsed.review.findings);
  assertDeclaredTtl(parsed.review);
  return parsed;
}

export function parseRecordedResponse(exchange: PublicHttpExchange): unknown {
  const { status, body } = exchange.response;
  const method = exchange.request.method.toUpperCase();
  const path = exchange.request.path;

  if (status === 204) {
    if (body !== null && body !== undefined && body !== "") {
      throw new Error("DELETE 204 must not return a body");
    }
    return null;
  }

  if (status >= 400) {
    const parsed = errorBodySchema.parse(body);
    const expectedHttp = ERROR_CODE_HTTP.get(parsed.error.code);
    if (expectedHttp !== status) {
      throw new Error(
        `Error code ${parsed.error.code} is frozen at HTTP ${expectedHttp}, got ${status}`,
      );
    }
    assertNoInternalLeakage(parsed);
    assertNoSuccessEmptyClaim(parsed);
    return parsed;
  }

  if (method === "POST" && path === "/api/v1/auth/wechat") {
    const parsed = loginSuccessSchema.parse(body);
    assertNoInternalLeakage(parsed, { allowSessionToken: true });
    if ("openid" in parsed || "unionid" in parsed || "user_id" in parsed) {
      throw new Error("Login response must not include OpenID or user_id");
    }
    return parsed;
  }

  if (method === "POST" && path === "/api/v1/reviews") {
    const parsed = createAcceptedSchema.parse(body);
    if (status !== 202) {
      throw new Error(`POST /api/v1/reviews success must be 202, got ${status}`);
    }
    assertNoInternalLeakage(parsed);
    return parsed;
  }

  if (method === "PATCH" || (method === "GET" && path.startsWith("/api/v1/reviews/"))) {
    return parseReviewEnvelope(body);
  }

  throw new Error(`No contract parser for ${method} ${path} HTTP ${status}`);
}

export { contractSpec };
