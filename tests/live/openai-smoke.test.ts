/** @vitest-environment node */
import { beforeAll, describe, expect, test } from "vitest";

import {
  LIVE_SMOKE_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "../helpers/live-intent";

describe("OpenAI live smoke (explicit opt-in, not production)", () => {
  let apiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      LIVE_SMOKE_INTENT,
      "Run `npm run test:live-smoke` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("OPENAI_API_KEY");
  });

  test("live provider returns schema-valid candidates at least once", async () => {
    const { OpenAIReviewModel } = await import(
      "@/lib/server/llm/openai-review-model"
    );
    const { createReview } = await import("@/lib/server/review-service");
    const model = new OpenAIReviewModel({ apiKey });
    const result = await createReview(
      {
        title: "我市召开座谈会",
        body: "市教育局局长王海涛出席。王强在总结时强调要抓好开学工作。",
      },
      model,
    );
    expect(result.pipeline.provider).toBe("openai");
    expect(Array.isArray(result.findings)).toBe(true);
    for (const finding of result.findings) {
      const text =
        finding.source_span.field === "title"
          ? result.article.title
          : result.article.body;
      expect(
        text.slice(
          finding.source_span.start_offset,
          finding.source_span.end_offset,
        ),
      ).toBe(finding.source_span.quoted_text);
    }
  }, 60_000);
});
