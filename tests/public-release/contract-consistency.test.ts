import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  BODY_MAX_UTF16,
  contractSpec,
  DEGRADED_CAUTION,
  DECLARED_TTL_HOURS,
  ERROR_CODE_HTTP,
  getReviewResponseSchema,
  parseRecordedResponse,
  PRIVACY_NOTICE_VERSION,
  STABLE_ERROR_CODES,
  TITLE_MAX_UTF16,
} from "./api-v0-contract";
import { loadAllScenarios, PUBLIC_API_FIXTURE_ROOT, readJson } from "./fixture-catalog";

describe("API v0 status enum", () => {
  test("frozen statuses each have a GET snapshot", () => {
    const examples = readJson<{ examples: Record<string, unknown> }>(
      "contract/status-examples.json",
    ).examples;
    expect(Object.keys(examples).sort()).toEqual([...contractSpec.review_statuses].sort());
    for (const status of contractSpec.review_statuses) {
      const parsed = getReviewResponseSchema.parse(examples[status]);
      expect(parsed.review.status).toBe(status);
      if (status === "degraded") {
        expect(parsed.review.degradation_notice).toBe(DEGRADED_CAUTION);
      }
    }
  });
});

describe("API v0 stable error codes", () => {
  test("every frozen code has HTTP mapping and a leak-free example", () => {
    const examples = readJson<{
      examples: Array<{ http: number; code: string; body: unknown }>;
    }>("contract/error-examples.json").examples;
    expect(examples.map((item) => item.code).sort()).toEqual([...STABLE_ERROR_CODES].sort());
    for (const example of examples) {
      expect(ERROR_CODE_HTTP.get(example.code)).toBe(example.http);
      parseRecordedResponse({
        request: { method: "POST", path: "/api/v1/reviews", headers: {}, body: {} },
        response: { status: example.http, headers: {}, body: example.body },
      });
    }
  });
});

describe("degraded caution", () => {
  test("uses the exact frozen risk warning", () => {
    expect(DEGRADED_CAUTION).toBe(
      "模型审校未完成，本轮仅完成规则检查，不能视为稿件没有问题。",
    );
    const degraded = loadAllScenarios().find((item) => item.id === "degraded");
    const body = degraded?.steps[1]?.response.body as {
      review: { degradation_notice: string; failure_code: null };
    };
    expect(body.review.degradation_notice).toBe(DEGRADED_CAUTION);
    expect(body.review.failure_code).toBeNull();
  });
});

describe("delete semantics", () => {
  test("records 204, GET 404, and idempotent repeat DELETE 204", () => {
    expect(contractSpec.delete.http).toBe(204);
    expect(contractSpec.delete.subsequent_get_code).toBe("REVIEW_NOT_FOUND");
    expect(contractSpec.delete.repeat_delete_http).toBe(204);
    expect(contractSpec.delete.irreversible).toBe(true);
    expect(contractSpec.delete.deployment_status).toBe("NOT_VERIFIED");
    const scenario = loadAllScenarios().find((item) => item.id === "delete");
    expect(scenario?.deployment_status).toBe("NOT_VERIFIED");
    expect(scenario?.steps.map((step) => step.response.status)).toEqual([202, 200, 204, 404, 204]);
  });
});

describe("ownership isolation", () => {
  test("review_id is not authorization and non-owners see REVIEW_NOT_FOUND", () => {
    expect(contractSpec.ownership.review_id_is_not_authorization).toBe(true);
    expect(contractSpec.ownership.authenticated_non_owner).toEqual({
      http: 404,
      code: "REVIEW_NOT_FOUND",
    });
    const forbidden = loadAllScenarios().find((item) => item.id === "forbidden");
    const bGet = forbidden?.steps.find((step) => step.name === "owner_b_get");
    expect(bGet?.request.path).toBe("/api/v1/reviews/rev_fixture_owner_a");
    expect(bGet?.request.headers.authorization).toBe("Bearer sess_fixture_owner_b_0000000000001");
    expect(bGet?.response.status).toBe(404);
    expect((bGet?.response.body as { error: { code: string } }).error.code).toBe("REVIEW_NOT_FOUND");
  });
});

describe("TTL declaration", () => {
  test("declares 24h retention without claiming a deployed cleaner", () => {
    expect(DECLARED_TTL_HOURS).toBe(24);
    expect(contractSpec.ttl.deployment_status).toBe("NOT_VERIFIED");
    expect(contractSpec.ttl.note).toMatch(/not deployed/i);
    const success = loadAllScenarios().find((item) => item.id === "success");
    const create = success?.steps.find((step) => step.name === "create")?.response.body as {
      expires_at: string;
    };
    expect(Date.parse(create.expires_at) - Date.parse("2026-09-01T00:00:00.000Z")).toBe(
      24 * 3600 * 1000,
    );
  });
});

describe("Public API v0 limits", () => {
  test("fixtures freeze public-v1, 200/10000, and backend error vocabulary", () => {
    expect(PRIVACY_NOTICE_VERSION).toBe("public-v1");
    expect(TITLE_MAX_UTF16).toBe(200);
    expect(BODY_MAX_UTF16).toBe(10000);
    expect(STABLE_ERROR_CODES).toContain("IDEMPOTENCY_CONFLICT");
    expect(STABLE_ERROR_CODES).toContain("PRIVACY_NOTICE_OUTDATED");
    expect(ERROR_CODE_HTTP.get("IDEMPOTENCY_CONFLICT")).toBe(409);
    expect(ERROR_CODE_HTTP.get("INTERNAL_ERROR")).toBe(500);
  });
});

describe("logging policy declaration", () => {
  test("does not claim production logging is deployed", () => {
    expect(contractSpec.logging_policy.deployment_status).toBe("NOT_VERIFIED");
    const sample = readFileSync(join(PUBLIC_API_FIXTURE_ROOT, "logs/safe-sample.jsonl"), "utf8");
    expect(sample).toContain("owner_key");
    expect(sample).not.toContain("Bearer");
  });
});
