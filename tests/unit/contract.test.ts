import { describe, expect, test } from "vitest";

import {
  llmReviewOutputSchema,
  parseLlmReviewOutput,
  ReviewProviderError,
  MODEL_SPECIALIST_IDS,
  SPECIALIST_MAX_PER_ARTICLE,
  specialistOrchestrationRunSchema,
  specialistResultSchema,
  specialistTaskSchema,
  sourceCandidateSchema,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  parseWebEvidenceResult,
  webEvidenceQuerySchema,
  webEvidenceResultSchema,
} from "@grc/contracts";

const validCandidate = {
  type: "person",
  severity: "high",
  title: "职务可能有误",
  reason: "人名与职务不匹配。",
  suggestion: {
    text: "改为市委书记张明",
    replacement: "市委书记张明",
  },
  confidence: 0.8,
  evidence: [
    {
      kind: "ai_judgment",
      excerpt: "仅根据文内信息判断。",
      citation_validated: false,
    },
  ],
  source: {
    field: "body",
    exact_quote: "市委书记张三",
    paragraph_index: 0,
    context_before: null,
    context_after: null,
  },
};

describe("LLM candidate contract", () => {
  test("accepts valid structured output", () => {
    const parsed = parseLlmReviewOutput({ candidates: [validCandidate] });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.suggestion.replacement).toBe("市委书记张明");
    expect(parsed.candidates[0]?.evidence[0]?.kind).toBe("ai_judgment");
  });

  test("rejects malformed output", () => {
    expect(() => parseLlmReviewOutput({ findings: [] })).toThrow(
      ReviewProviderError,
    );
    expect(() => parseLlmReviewOutput(null)).toThrow(ReviewProviderError);
    expect(() => parseLlmReviewOutput("not-json-object")).toThrow(
      ReviewProviderError,
    );
  });

  test("rejects invalid enum", () => {
    const result = llmReviewOutputSchema.safeParse({
      candidates: [
        {
          ...validCandidate,
          type: "typo",
          severity: "urgent",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid source candidate", () => {
    expect(
      sourceCandidateSchema.safeParse({
        field: "body",
        exact_quote: "",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      }).success,
    ).toBe(false);

    expect(
      sourceCandidateSchema.safeParse({
        field: "headline",
        exact_quote: "张三",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      }).success,
    ).toBe(false);

    expect(
      llmReviewOutputSchema.safeParse({
        candidates: [
          {
            ...validCandidate,
            source: {
              field: "body",
              exact_quote: "",
              paragraph_index: -1,
              context_before: null,
              context_after: null,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("allows empty string replacement as span deletion", () => {
    const parsed = parseLlmReviewOutput({
      candidates: [
        {
          ...validCandidate,
          suggestion: { text: "删除该片段", replacement: "" },
        },
      ],
    });
    expect(parsed.candidates[0]?.suggestion.replacement).toBe("");
  });
});

describe("MA-0 specialist contracts", () => {
  const article = {
    title: "测试标题",
    body: "正文含有政策名称。",
    version: 1,
  };
  const sourceSpan = {
    field: "body" as const,
    start_offset: 4,
    end_offset: 8,
    quoted_text: "政策名称",
    paragraph_index: 0,
    article_version: 1,
  };

  test("accepts the planned task envelope", () => {
    const parsed = specialistTaskSchema.parse({
      taskId: "task-001",
      specialist: "policy",
      article,
      candidateSpans: [sourceSpan],
      retrievedEvidence: [
        {
          source_id: "source-001",
          source_name: "权威来源",
          source_url: "https://example.invalid/source",
          authority_level: "official",
          published_at: "2026-01-01",
          valid_from: "2026-01-01",
          valid_to: null,
          excerpt: "政策名称应使用规范全称。",
          match_rank: 402,
          trigger: "政策名称",
        },
      ],
      constraints: {
        maxCandidates: 5,
        deadlineMs: 2_000,
        allowExternalRetrieval: false,
      },
    });
    expect(parsed.specialist).toBe("policy");
    expect(parsed.constraints.allowExternalRetrieval).toBe(false);
  });

  test("accepts candidates, provenance, and warnings in the result envelope", () => {
    const parsed = specialistResultSchema.parse({
      taskId: "task-001",
      candidates: [validCandidate],
      provenance: {
        taskId: "task-001",
        specialist: "policy",
        invoked: true,
        status: "succeeded",
        provider: "deepseek",
        model: "deepseek-chat",
        elapsedMs: 120,
      },
      warnings: [],
    });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.provenance.status).toBe("succeeded");
  });

  test("accepts optional observed model and usage on specialist provenance", () => {
    const parsed = specialistResultSchema.parse({
      taskId: "fact_check:1",
      candidates: [],
      provenance: {
        taskId: "fact_check:1",
        specialist: "fact_check",
        invoked: true,
        status: "succeeded",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        elapsedMs: 840,
        observed_response_model: "deepseek-v4-flash",
        attempt_count: 1,
        aggregated_usage: {
          input_tokens: 120,
          input_tokens_completeness: "complete",
          output_tokens: 40,
          output_tokens_completeness: "complete",
          cached_input_tokens: 0,
          cached_input_tokens_status: "reported",
          cached_input_tokens_completeness: "complete",
          unobserved_usage_attempts: 0,
        },
      },
      warnings: [],
    });
    expect(parsed.provenance.observed_response_model).toBe("deepseek-v4-flash");
    expect(parsed.provenance.attempt_count).toBe(1);
    expect(parsed.provenance.aggregated_usage?.input_tokens).toBe(120);
  });

  test("defaults missing specialist call traces to unobserved", () => {
    const parsed = specialistResultSchema.parse({
      taskId: "news_edit:1",
      candidates: [],
      provenance: {
        taskId: "news_edit:1",
        specialist: "news_edit",
        invoked: true,
        status: "failed",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        elapsedMs: 12,
      },
      warnings: ["专项核验失败，待人工核实"],
    });
    expect(parsed.provenance.trace_status).toBe("unobserved");
    expect(parsed.provenance.observed_response_model).toBeNull();
    expect(parsed.provenance.attempts).toEqual([]);
    expect(parsed.provenance.aggregated_usage.input_tokens_completeness).toBe("not_observed");
  });

  test("accepts fact_check and news_edit fragment tasks without the full article", () => {
    expect(MODEL_SPECIALIST_IDS).toEqual(["fact_check", "news_edit"]);
    expect(SPECIALIST_MAX_PER_ARTICLE).toBe(2);
    const parsed = specialistTaskSchema.parse({
      taskId: "fact_check:1",
      specialist: "fact_check",
      fragments: [
        {
          field: "body",
          start_offset: 4,
          end_offset: 8,
          quoted_text: "政策名称",
          paragraph_index: 0,
          article_version: 1,
          context_before: "正文含有",
          context_after: "。",
        },
      ],
      preliminaryFindings: [
        {
          type: "policy",
          severity: "high",
          title: "政策名称待核验",
          reason: "政策名称可能不是规范全称。",
          source_span: sourceSpan,
          confidence: 0.6,
        },
      ],
      candidateSpans: [sourceSpan],
      retrievedEvidence: [],
      constraints: {
        maxCandidates: 5,
        deadlineMs: 2_000,
        allowExternalRetrieval: false,
      },
    });
    expect(parsed.article).toBeUndefined();
    expect(parsed.fragments).toHaveLength(1);
    expect(parsed.webEvidence).toEqual([]);
    expect(parsed.preliminaryFindings[0]?.type).toBe("policy");
  });

  test("accepts an orchestration run with verify judgments", () => {
    const parsed = specialistOrchestrationRunSchema.parse({
      enabled: true,
      target_model: "deepseek-v4-flash",
      dispatched: ["fact_check", "news_edit"],
      skipped: [],
      budget: { max_specialists: 2, used: 2 },
      results: [
        {
          taskId: "fact_check:1",
          candidates: [validCandidate],
          provenance: {
            taskId: "fact_check:1",
            specialist: "fact_check",
            invoked: true,
            status: "succeeded",
            provider: "fixture",
            model: "fake-specialist",
            elapsedMs: 1,
          },
          warnings: [],
        },
      ],
      judgments: [
        {
          field: "body",
          paragraph_index: 0,
          quoted_text: "政策名称",
          decision: "verify",
          reason: "专家结论存在分歧，待人工核实",
          specialist_ids: ["fact_check", "news_edit"],
          requires_verification: true,
        },
      ],
      warnings: [],
    });
    expect(parsed.judgments[0]?.decision).toBe("verify");
    expect(parsed.budget.max_specialists).toBe(2);
  });
});

describe("web evidence contracts", () => {
  const retrievedAt = "2026-08-26T00:00:00.000Z";

  test("accepts a serializable query, item, and retrieved result", () => {
    const query = webEvidenceQuerySchema.parse({
      query_text: "市教育局局长王海涛",
      fact_category: "person_title",
      allowed_domains: ["gov.cn"],
      language: "zh-CN",
      region: "CN",
      max_results: 3,
    });
    expect(query.max_results).toBe(3);

    const result = parseWebEvidenceResult({
      evidence: [
        {
          source_name: "中国政府网",
          url: "https://www.gov.cn/example",
          title: "人物职务",
          excerpt: "市教育局局长王海涛出席。",
          published_or_version_date: "2026-01-01",
          retrieved_at: retrievedAt,
          source_tier: "official",
        },
      ],
      status: "retrieved",
      error_class: "none",
      message: "已返回可追溯网页证据，仅供审校判断，不构成外部核验结论",
      provenance: {
        provider_id: "fake-offline",
        provider_kind: "fake_offline",
        live_network: false,
        retrieved_at: retrievedAt,
        query_text: query.query_text,
        fact_category: "person_title",
      },
    });
    expect(result.evidence[0]?.url).toContain("gov.cn");
  });

  test("rejects fake offline provenance that claims a live network", () => {
    expect(
      webEvidenceResultSchema.safeParse({
        evidence: [],
        status: "unverified",
        error_class: "not_found",
        message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
        provenance: {
          provider_id: "fake-offline",
          provider_kind: "fake_offline",
          live_network: true,
          retrieved_at: retrievedAt,
          query_text: "市教育局局长王海涛",
          fact_category: "person_title",
        },
      }).success,
    ).toBe(false);
  });

  test("unverified results must use the canonical message and cannot look like a clean bill", () => {
    expect(
      webEvidenceResultSchema.safeParse({
        evidence: [],
        status: "unverified",
        error_class: "not_found",
        message: "没有问题",
        provenance: {
          provider_id: "fake-offline",
          provider_kind: "fake_offline",
          live_network: false,
          retrieved_at: retrievedAt,
          query_text: "市教育局局长王海涛",
          fact_category: "person_title",
        },
      }).success,
    ).toBe(false);
  });
});
