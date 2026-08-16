import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  BODY_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  createReviewResponseSchema,
  type ReviewCandidate,
} from "@/lib/contracts/review";
import { createReviewPostHandler } from "@/app/api/reviews/route";
import { createFindingPatchHandler } from "@/app/api/reviews/[reviewId]/findings/[findingId]/route";
import { openReviewDatabase } from "@/lib/server/db";
import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import type { ReviewModel } from "@/lib/server/llm/review-model";
import { ReviewStore } from "@/lib/server/review-store";

const demoArticle = JSON.parse(
  readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
) as { title: string; body: string };

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

class FailingModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model = "test-model";
  review(): Promise<ReviewCandidate[]> {
    return Promise.reject(new Error("provider down"));
  }
}

class MalformedModel implements ReviewModel {
  readonly provider = "openai" as const;
  readonly model = "test-model";
  review(): Promise<ReviewCandidate[]> {
    return Promise.resolve([{ type: "nope" }] as unknown as ReviewCandidate[]);
  }
}

describe("POST /api/reviews", () => {
  test("valid POST with fixture provider returns schema-valid findings", async () => {
    const store = new ReviewStore(openReviewDatabase(":memory:"));
    const handler = createReviewPostHandler(new FixtureReviewModel(), store);
    const response = await handler(jsonRequest("http://localhost/api/reviews", demoArticle));
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await response.json());
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.findings.every((finding) => finding.status === "pending")).toBe(true);
    expect(store.getReview(payload.review_id).review_id).toBe(payload.review_id);
    for (const finding of payload.findings) {
      const text =
        finding.source_span.field === "title"
          ? payload.article.title
          : payload.article.body;
      expect(
        text.slice(finding.source_span.start_offset, finding.source_span.end_offset),
      ).toBe(finding.source_span.quoted_text);
    }
  });

  test("missing title or body is rejected", async () => {
    const handler = createReviewPostHandler(
      new FixtureReviewModel(),
      new ReviewStore(openReviewDatabase(":memory:")),
    );
    expect((await handler(jsonRequest("http://localhost/api/reviews", { body: "正文" }))).status).toBe(400);
    expect((await handler(jsonRequest("http://localhost/api/reviews", { title: "标题" }))).status).toBe(400);
  });

  test("empty article is rejected", async () => {
    const handler = createReviewPostHandler(
      new FixtureReviewModel(),
      new ReviewStore(openReviewDatabase(":memory:")),
    );
    const response = await handler(
      jsonRequest("http://localhost/api/reviews", { title: "标题", body: "" }),
    );
    expect(response.status).toBe(400);
  });

  test("oversize article is rejected", async () => {
    const handler = createReviewPostHandler(
      new FixtureReviewModel(),
      new ReviewStore(openReviewDatabase(":memory:")),
    );
    const response = await handler(
      jsonRequest("http://localhost/api/reviews", {
        title: "标".repeat(TITLE_MAX_LENGTH + 1),
        body: "正".repeat(BODY_MAX_LENGTH + 1),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("mocked provider success can return an empty finding list", async () => {
    const handler = createReviewPostHandler(
      new FixtureReviewModel([]),
      new ReviewStore(openReviewDatabase(":memory:")),
    );
    const response = await handler(
      jsonRequest("http://localhost/api/reviews", {
        title: "标题",
        body: "这是一篇没有预置问题的稿件。",
      }),
    );
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await response.json());
    expect(payload.findings).toEqual([]);
  });

  test("mocked provider failure returns 502", async () => {
    const store = new ReviewStore(openReviewDatabase(":memory:"));
    const unavailable = createReviewPostHandler(new FailingModel(), store);
    const malformed = createReviewPostHandler(new MalformedModel(), store);
    expect(
      (await unavailable(jsonRequest("http://localhost/api/reviews", demoArticle))).status,
    ).toBe(502);
    expect(
      (await malformed(jsonRequest("http://localhost/api/reviews", demoArticle))).status,
    ).toBe(502);
  });
});

describe("PATCH /api/reviews/{id}/findings/{id}", () => {
  test("Accept / Ignore / Verify roundtrip through the route handler", async () => {
    const store = new ReviewStore(openReviewDatabase(":memory:"));
    const post = createReviewPostHandler(new FixtureReviewModel(), store);
    const created = createReviewResponseSchema.parse(
      await (await post(jsonRequest("http://localhost/api/reviews", demoArticle))).json(),
    );
    const patch = createFindingPatchHandler(store);
    const params = (reviewId: string, findingId: string) =>
      Promise.resolve({ reviewId, findingId });

    const safe = created.findings.find((item) => item.suggestion.replacement !== null)!;
    const accepted = await patch(
      jsonRequest(
        `http://localhost/api/reviews/${created.review_id}/findings/${safe.finding_id}`,
        { action: "accept", expected_article_version: 1, action_id: "p-accept" },
        "PATCH",
      ),
      { params: params(created.review_id, safe.finding_id) },
    );
    expect(accepted.status).toBe(200);
    const afterAccept = createReviewResponseSchema.parse(await accepted.json());
    expect(afterAccept.article.version).toBe(2);
    expect(afterAccept.findings.find((item) => item.finding_id === safe.finding_id)?.status).toBe(
      "accepted",
    );

    const remaining = afterAccept.findings.find(
      (item) => item.status === "pending" && item.suggestion.replacement !== null,
    )!;
    const verified = await patch(
      jsonRequest(
        `http://localhost/api/reviews/${created.review_id}/findings/${remaining.finding_id}`,
        {
          action: "verify",
          expected_article_version: afterAccept.article.version,
          action_id: "p-verify",
        },
        "PATCH",
      ),
      { params: params(created.review_id, remaining.finding_id) },
    );
    expect(verified.status).toBe(200);
    const afterVerify = createReviewResponseSchema.parse(await verified.json());
    expect(afterVerify.article.version).toBe(afterAccept.article.version);
    expect(
      afterVerify.findings.find((item) => item.finding_id === remaining.finding_id)?.status,
    ).toBe("verify");
  });
});
