import { describe, expect, test } from "vitest";

import {
  llmReviewOutputSchema,
  parseLlmReviewOutput,
  ReviewProviderError,
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
