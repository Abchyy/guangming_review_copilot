import { describe, expect, test } from "vitest";

import { parseRecordedResponse } from "./api-v0-contract";
import { loadAllScenarios, loadCatalog, loadSyntheticArticle } from "./fixture-catalog";
import { replayScenario, replayStep } from "./fixture-replay";

const REQUIRED_SCENARIO_IDS = [
  "success",
  "degraded",
  "failed",
  "unauthenticated",
  "forbidden",
  "idempotent-retry",
  "idempotent-conflict",
  "invalid-request",
  "article-too-large",
  "content-rejected",
  "daily-quota-exceeded",
  "rate-limited",
  "delete",
  "unavailable",
] as const;

describe("API v0 fixture catalog", () => {
  test("loads every required scenario without calling product code", () => {
    const catalog = loadCatalog();
    expect(catalog.live_calls_forbidden).toBe(true);
    expect(catalog.product_working_name).toBe("AI 审校助手");
    expect((catalog as { privacy_notice_version?: string }).privacy_notice_version).toBe(
      "public-v1",
    );
    expect(catalog.disclaimer).toMatch(/not a live WeChat/i);
    const ids = catalog.scenarios.map((item) => item.id);
    expect(ids).toEqual([...REQUIRED_SCENARIO_IDS]);
    expect(loadAllScenarios()).toHaveLength(REQUIRED_SCENARIO_IDS.length);
  });
});

describe("API v0 black-box fixture replay", () => {
  const scenarios = loadAllScenarios();

  for (const scenario of scenarios) {
    test(`${scenario.id}: ${scenario.title}`, async () => {
      expect(scenario.evidence_class).toBe("FIXTURE_VERIFIED");
      expect(scenario.deployment_status).toBe("NOT_VERIFIED");
      const results = await replayScenario(scenario);
      expect(results).toHaveLength(scenario.steps.length);

      for (const [index, step] of scenario.steps.entries()) {
        const observed = results[index];
        expect(observed?.status, step.name).toBe(step.response.status);
        expect(observed?.body, step.name).toEqual(step.response.body ?? null);
        parseRecordedResponse({
          request: step.request,
          response: {
            status: observed?.status ?? 0,
            headers: observed?.headers ?? {},
            body: observed?.body ?? null,
          },
        });
      }
    });
  }

  test("success path keeps request_id and a stable review_id", async () => {
    const success = scenarios.find((item) => item.id === "success");
    expect(success).toBeTruthy();
    const results = await replayScenario(success!);
    const create = results[1]?.body as { review_id: string; request_id: string; status: string };
    const get = results[2]?.body as { review: { review_id: string; status: string } };
    expect(create.status).toBe("queued");
    expect(get.review.status).toBe("succeeded");
    expect(get.review.review_id).toBe(create.review_id);
  });

  test("idempotent retry reuses review_id", async () => {
    const scenario = scenarios.find((item) => item.id === "idempotent-retry");
    const results = await replayScenario(scenario!);
    const first = results[0]?.body as { review_id: string };
    const second = results[1]?.body as { review_id: string };
    expect(first.review_id).toBe(second.review_id);
    expect(scenario?.assertions?.declared_quota_deductions).toBe(1);
  });

  test("delete is 204, GET is REVIEW_NOT_FOUND, repeat DELETE is 204", async () => {
    const scenario = scenarios.find((item) => item.id === "delete");
    const results = await replayScenario(scenario!);
    expect(results.map((item) => item.status)).toEqual([202, 200, 204, 404, 204]);
    expect(results[2]?.body).toBeNull();
    const missing = results[3]?.body as { error: { code: string } };
    expect(missing.error.code).toBe("REVIEW_NOT_FOUND");
    expect(results[4]?.body).toBeNull();
  });

  test("owner B cannot read owner A's article", async () => {
    const scenario = scenarios.find((item) => item.id === "forbidden");
    const results = await replayScenario(scenario!);
    const ownerB = results[1]?.body as { error: { code: string }; review?: unknown };
    const ownerA = results[4]?.body as { review: { review_id: string; status: string } };
    expect(results[1]?.status).toBe(404);
    expect(ownerB.error.code).toBe("REVIEW_NOT_FOUND");
    expect(ownerB.review).toBeUndefined();
    expect(ownerA.review.review_id).toBe("rev_fixture_owner_a");
  });

  test("fixtures use public-v1 privacy notice and frozen conflict/ownership codes", () => {
    const serialized = JSON.stringify(scenarios);
    expect(serialized).not.toContain("fixture-pn-v0");
    const conflict = scenarios.find((item) => item.id === "idempotent-conflict");
    const conflictBody = conflict?.steps[1]?.response.body as { error: { code: string } };
    expect(conflictBody.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict?.steps[1]?.response.status).toBe(409);
    const forbidden = scenarios.find((item) => item.id === "forbidden");
    expect(
      forbidden?.steps
        .filter((step) => step.name.startsWith("owner_b_"))
        .every((step) => step.response.status === 404),
    ).toBe(true);
  });

  test("expanded oversize bodies use Public V1 UTF-16 limits", async () => {
    const scenario = scenarios.find((item) => item.id === "article-too-large");
    const title = scenario?.steps[0]?.request.body as { title: string };
    const body = scenario?.steps[1]?.request.body as { body: string };
    expect(title.title.length).toBe(201);
    expect(body.body.length).toBe(10001);
    const titleResult = await replayStep(scenario!.steps[0]!);
    const bodyResult = await replayStep(scenario!.steps[1]!);
    expect((titleResult.body as { error: { code: string } }).error.code).toBe("ARTICLE_TOO_LARGE");
    expect((bodyResult.body as { error: { code: string } }).error.code).toBe("ARTICLE_TOO_LARGE");
  });

  test("synthetic article is not a real user manuscript", () => {
    const article = loadSyntheticArticle();
    expect(article.title).toContain("示例");
    expect(article.body).toContain("示例讯");
    expect(article.body).not.toMatch(/李明|王海涛|光明/);
  });
});
