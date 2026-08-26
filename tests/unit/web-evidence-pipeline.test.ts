import { describe, expect, test } from "vitest";

import type { CreateReviewResponse, ReviewCandidate, WebEvidenceCollector } from "@grc/contracts";
import { WEB_EVIDENCE_UNVERIFIED_MESSAGE } from "@grc/contracts";
import { FixtureReviewModel } from "@grc/providers";
import { createReview } from "@grc/review-core";
import {
  FakeSearchProvider,
  createWebEvidenceCollector,
  createWebEvidenceCollectorFromEnv,
} from "@grc/web-evidence";

const article = {
  title: "我市召开基础教育高质量发展座谈会",
  body: "上周四（8月12日）召开座谈谈会。市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。本次座谈会由市教育委员会主办。要学习《教育强国建设规划纲要（2023－2035年）》。王强在总结时强调开学工作。另据通报义务教育阶段在校生共182万人。",
};

const personCandidate: ReviewCandidate = {
  type: "person",
  severity: "high",
  title: "职务待核验",
  reason: "人名与职务需外部核验。",
  suggestion: { text: "建议人工核实，无安全自动替换。", replacement: null },
  confidence: 0.7,
  evidence: [{ kind: "ai_judgment", excerpt: "文内职务表述。", citation_validated: false }],
  source: {
    field: "body",
    exact_quote: "市教育局局长王海涛",
    paragraph_index: 0,
    context_before: null,
    context_after: null,
  },
};

function pipelineCore(result: CreateReviewResponse) {
  return {
    findings: result.findings,
    pipeline: {
      provider: result.pipeline.provider,
      model: result.pipeline.model,
      candidate_count: result.pipeline.candidate_count,
      located_count: result.pipeline.located_count,
      dropped_count: result.pipeline.dropped_count,
      fallback: result.pipeline.fallback,
      specialists_enabled: result.pipeline.specialists_enabled,
    },
  };
}

describe("review-core web evidence integration", () => {
  test("unconfigured pipeline behavior is unchanged", async () => {
    const model = new FixtureReviewModel([personCandidate]);
    const implicit = await createReview(article, model);
    const explicitOff = await createReview(article, model, {
      webEvidenceCollector: null,
    });
    const envOff = await createReview(article, model, {
      webEvidenceCollector: createWebEvidenceCollectorFromEnv({
        env: { TAVILY_API_KEY: "tvly-dev-test" },
      }),
    });

    expect(implicit.pipeline.web_evidence).toBeUndefined();
    expect(explicitOff.pipeline.web_evidence).toBeUndefined();
    expect(envOff.pipeline.web_evidence).toBeUndefined();
    expect(pipelineCore(implicit)).toEqual(pipelineCore(explicitOff));
    expect(pipelineCore(implicit)).toEqual(pipelineCore(envOff));
    expect(implicit.pipeline.specialists_enabled).toBe(false);
  });

  test("optional collector attaches web evidence without changing findings", async () => {
    const model = new FixtureReviewModel([personCandidate]);
    const baseline = await createReview(article, model);
    const enabled = await createReview(article, model, {
      webEvidenceCollector: createWebEvidenceCollector(
        new FakeSearchProvider({ now: () => new Date("2026-08-26T08:00:00.000Z") }),
      ),
    });

    expect(baseline.pipeline.web_evidence).toBeUndefined();
    expect(enabled.findings).toEqual(baseline.findings);
    expect(pipelineCore(enabled)).toEqual(pipelineCore(baseline));
    expect(enabled.pipeline.web_evidence?.enabled).toBe(true);
    expect(enabled.pipeline.web_evidence?.query_count).toBeGreaterThan(0);
    expect(enabled.pipeline.web_evidence?.query_count).toBeLessThanOrEqual(2);
    expect(
      enabled.pipeline.web_evidence?.results.every((item) => item.evidence.length <= 3),
    ).toBe(true);
  });

  test("collector failure degrades to 未能外部核验 and does not fail the review", async () => {
    const exploding: WebEvidenceCollector = {
      collect() {
        return Promise.reject(new Error("collector exploded"));
      },
    };
    const result = await createReview(article, new FixtureReviewModel([personCandidate]), {
      webEvidenceCollector: exploding,
    });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.pipeline.web_evidence?.enabled).toBe(true);
    expect(result.pipeline.web_evidence?.results[0]?.status).toBe("unverified");
    expect(result.pipeline.web_evidence?.results[0]?.message).toBe(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(result.pipeline.web_evidence?.results[0]?.error_class).toBe("provider_failure");
  });
});
