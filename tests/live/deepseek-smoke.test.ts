/** @vitest-environment node */
import { beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_PRODUCTION_MODEL } from "@grc/providers";
import { assertObservedModelMatchesExpected } from "@grc/providers";
import {
  LIVE_SMOKE_INTENT,
  requireEnvApiKey,
  requireExplicitIntent,
} from "@grc/test-kit";

describe("DeepSeek live smoke (explicit opt-in only)", () => {
  let apiKey: string;

  beforeAll(() => {
    requireExplicitIntent(
      LIVE_SMOKE_INTENT,
      "Run `npm run test:live-smoke` instead of `npm test`.",
    );
    apiKey = requireEnvApiKey("DEEPSEEK_API_KEY");
  });

  test("domestic provider returns schema-valid located findings", async () => {
    const { DeepSeekReviewModel } = await import("@grc/providers");
    const { createReview } = await import("@grc/review-core");
    const model = new DeepSeekReviewModel({ apiKey });
    const result = await createReview(
      {
        title: "我市召开座谈会",
        body: "上周四（8月12日），市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。另据通报，义务教育阶段在校生共182万人。",
      },
      model,
      { useCache: false },
    );
    expect(result.pipeline.provider).toBe("deepseek");
    expect(result.pipeline.provenance?.adapter_provider).toBe("deepseek");
    expect(result.pipeline.provenance?.requested_model).toBe(DEFAULT_PRODUCTION_MODEL);
    expect(result.pipeline.provenance?.application_cache.hit).toBe(false);
    assertObservedModelMatchesExpected(result.pipeline.provenance!, DEFAULT_PRODUCTION_MODEL);
    expect(Array.isArray(result.findings)).toBe(true);
    for (const finding of result.findings) {
      const text =
        finding.source_span.field === "title" ? result.article.title : result.article.body;
      expect(
        text.slice(finding.source_span.start_offset, finding.source_span.end_offset),
      ).toBe(finding.source_span.quoted_text);
      expect(finding.evidence.every((item) => !item.source_url || item.kind === "retrieved_source")).toBe(
        true,
      );
    }
  }, 90_000);
});
