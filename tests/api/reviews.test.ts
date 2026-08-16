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
import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import type { ReviewModel } from "@/lib/server/llm/review-model";

const demoArticle = JSON.parse(
  readFileSync(join(process.cwd(), "data/fixtures/demo-article.json"), "utf8"),
) as { title: string; body: string };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
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
    const handler = createReviewPostHandler(new FixtureReviewModel());
    const response = await handler(jsonRequest(demoArticle));
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await readJson(response));
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.pipeline.provider).toBe("fixture");
    expect(payload.pipeline.dropped_count).toBe(0);
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
    const handler = createReviewPostHandler(new FixtureReviewModel());
    const missingTitle = await handler(jsonRequest({ body: "正文" }));
    const missingBody = await handler(jsonRequest({ title: "标题" }));
    expect(missingTitle.status).toBe(400);
    expect(missingBody.status).toBe(400);
  });

  test("empty article is rejected", async () => {
    const handler = createReviewPostHandler(new FixtureReviewModel());
    const response = await handler(jsonRequest({ title: "标题", body: "" }));
    expect(response.status).toBe(400);
  });

  test("oversize article is rejected", async () => {
    const handler = createReviewPostHandler(new FixtureReviewModel());
    const response = await handler(
      jsonRequest({
        title: "标".repeat(TITLE_MAX_LENGTH + 1),
        body: "正".repeat(BODY_MAX_LENGTH + 1),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("mocked provider success can return an empty finding list", async () => {
    const handler = createReviewPostHandler(new FixtureReviewModel([]));
    const response = await handler(
      jsonRequest({ title: "标题", body: "这是一篇没有预置问题的稿件。" }),
    );
    expect(response.status).toBe(200);
    const payload = createReviewResponseSchema.parse(await readJson(response));
    expect(payload.findings).toEqual([]);
  });

  test("mocked provider failure returns 502", async () => {
    const unavailable = createReviewPostHandler(new FailingModel());
    const malformed = createReviewPostHandler(new MalformedModel());
    expect((await unavailable(jsonRequest(demoArticle))).status).toBe(502);
    expect((await malformed(jsonRequest(demoArticle))).status).toBe(502);
  });
});
