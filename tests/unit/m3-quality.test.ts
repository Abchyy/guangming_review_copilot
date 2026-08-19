import { describe, expect, test } from "vitest";

import type { ReviewCandidate } from "@/lib/contracts/review";
import { openReviewDatabase } from "@/lib/server/db";
import { LlmCandidateCache } from "@/lib/server/llm/candidate-cache";
import { FixtureReviewModel } from "@/lib/server/llm/fixture-review-model";
import { buildCandidateCacheKey, hashCanonicalArticle } from "@/lib/server/quality/article-hash";
import { loadBenchmarkDataset } from "@/lib/server/benchmark/dataset";
import { evaluateReview } from "@/lib/server/benchmark/evaluate";
import { materializeLlmEvidence } from "@/lib/server/quality/evidence";
import { fuseFindings } from "@/lib/server/quality/fusion";
import { retrieveCorpus } from "@/lib/server/quality/retrieval";
import { runRules } from "@/lib/server/quality/rules";
import { overrideSeverity } from "@/lib/server/quality/severity";
import { createReview } from "@/lib/server/review-service";

const article = {
  title: "我市召开基础教育高质量发展座谈会",
  body: "上周四（8月12日）召开座谈谈会。市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。本次座谈会由市教育委员会主办。要学习《教育强国建设规划纲要（2023－2035年）》。王强在总结时强调开学工作。另据通报义务教育阶段在校生共182万人。",
  version: 1 as const,
};

describe("M3 rules, retrieval, evidence, fusion", () => {
  test("rules cover the first-version deterministic catalog", () => {
    const hits = runRules(article);
    const ids = new Set(hits.map((item) => item.rule_id));
    expect(ids.has("typo.zuotanhui")).toBe(true);
    expect(ids.has("datetime.weekday-mismatch")).toBe(true);
    expect(ids.has("metric.compulsory-enrollment")).toBe(true);
    expect(ids.has("entity.edu-bureau-name")).toBe(true);
    expect(ids.has("std.edu-outline-2024")).toBe(true);
    expect(ids.has("entity.wanghaitao-speaker")).toBe(true);
    expect(runRules({ title: "标题", body: "完成很好！！请注意。", version: 1 }).some((item) => item.rule_id === "punct.repeated")).toBe(true);
    expect(runRules({ title: "标题", body: "他说：“尚未结束。", version: 1 }).some((item) => item.rule_id === "punct.unclosed")).toBe(true);
  });

  test("retrieval only returns real corpus hits and respects top-k", () => {
    const retrieved = retrieveCorpus(article);
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.length).toBeLessThanOrEqual(5);
    expect(retrieveCorpus({ title: "天气很好", body: "今天没有机构或政策名称。", version: 1 })).toEqual([]);
  });

  test("unknown evidence IDs, forged URLs, and model-created citations are dropped", () => {
    const candidate: ReviewCandidate = {
      type: "policy",
      severity: "high",
      title: "伪造来源",
      reason: "模型编造了出处。",
      suggestion: { text: "人工核实", replacement: null },
      confidence: 0.4,
      evidence: [
        {
          kind: "retrieved_source",
          excerpt: "伪造摘录",
          citation_validated: true,
          source_id: "src.does-not-exist",
          source_url: "https://evil.example/forged",
        },
        {
          kind: "rule",
          excerpt: "伪造规则",
          citation_validated: true,
          rule_id: "rule.unknown",
        },
      ],
      source: {
        field: "body",
        exact_quote: "座谈谈会",
        paragraph_index: 0,
        context_before: null,
        context_after: null,
      },
    };
    const materialized = materializeLlmEvidence(article, candidate);
    expect(materialized.dropped_unknown_ids).toBe(true);
    expect(materialized.requires_verification).toBe(true);
    expect(materialized.evidence.every((item) => item.kind === "ai_judgment")).toBe(true);
    expect(materialized.evidence.every((item) => item.source_url == null)).toBe(true);

    const recovered = materializeLlmEvidence(article, {
      ...candidate,
      evidence: [
        {
          kind: "retrieved_source",
          excerpt: "教育强国",
          citation_validated: true,
          source_id: "src.edu-outline-2024",
          source_url: "https://evil.example/forged",
        },
      ],
    });
    expect(recovered.evidence[0]?.kind).toBe("retrieved_source");
    expect(recovered.evidence[0]?.source_url).toBe("https://www.moe.gov.cn/");
  });

  test("fusion prefers rule span/replacement and does not keep near-duplicates", () => {
    const ruleHits = runRules(article).filter((item) => item.rule_id === "typo.zuotanhui");
    const ruleDrafts = ruleHits.map((hit) => ({
      type: hit.type,
      severity: hit.severity,
      source_span: hit.source_span,
      title: hit.title,
      reason: hit.reason,
      suggestion: hit.suggestion,
      confidence: hit.confidence,
      evidence: [
        {
          kind: "rule" as const,
          excerpt: hit.reason,
          citation_validated: true,
          rule_id: hit.rule_id,
        },
      ],
      status: "pending" as const,
    }));
    const llmDrafts = ruleDrafts.map((item) => ({
      ...item,
      title: "模型也发现了",
      reason: "模型给出了更长的解释，用于融合。",
      suggestion: { text: "改成讨论会", replacement: "讨论会" },
      evidence: [{ kind: "ai_judgment" as const, excerpt: "判断", citation_validated: false }],
    }));
    const fused = fuseFindings(ruleDrafts, llmDrafts);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.suggestion.replacement).toBe("座谈会");
    expect(fused[0]?.evidence.some((item) => item.kind === "rule")).toBe(true);
  });

  test("model-only critical is downgraded and requires verification", () => {
    const overridden = overrideSeverity({
      type: "person",
      severity: "critical",
      source_span: {
        field: "body",
        start_offset: 0,
        end_offset: 2,
        quoted_text: "王强",
        paragraph_index: 0,
        article_version: 1,
      },
      title: "人物可能有误",
      reason: "仅模型判断",
      suggestion: { text: "核实", replacement: null },
      confidence: 0.5,
      evidence: [{ kind: "ai_judgment", excerpt: "无外部依据", citation_validated: false }],
      status: "pending",
    });
    expect(overridden.severity).toBe("high");
    expect(overridden.requires_verification).toBe(true);
  });

  test("candidate cache keys include provider and model", () => {
    const articleHash = hashCanonicalArticle("t", "b");
    const deepseek = buildCandidateCacheKey({
      articleHash,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersion: "m3.1.0",
      ruleVersion: "m3.1.0",
      corpusVersion: "m3.1.0",
      outputSchemaVersion: "m3.1.0",
      promptMode: "copilot",
    });
    const openai = buildCandidateCacheKey({
      articleHash,
      provider: "openai",
      model: "gpt-5.6-terra",
      promptVersion: "m3.1.0",
      ruleVersion: "m3.1.0",
      corpusVersion: "m3.1.0",
      outputSchemaVersion: "m3.1.0",
      promptMode: "copilot",
    });
    expect(deepseek).not.toBe(openai);
    const db = openReviewDatabase(":memory:");
    const cache = new LlmCandidateCache(db);
    cache.set(deepseek, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersion: "m3.1.0",
      ruleVersion: "m3.1.0",
      corpusVersion: "m3.1.0",
      outputSchemaVersion: "m3.1.0",
      articleHash,
      candidates: [],
    });
    expect(cache.get(openai)).toBeNull();
    expect(cache.get(deepseek)).toEqual([]);
  });

  test("gold quotes in the 18-article dataset are locatable", () => {
    const dataset = loadBenchmarkDataset();
    expect(dataset.articles.filter((item) => item.split === "dev")).toHaveLength(6);
    expect(dataset.articles.filter((item) => item.split === "regression")).toHaveLength(12);
    for (const item of dataset.articles) {
      const result = evaluateReview(
        { title: item.title, body: item.body, version: 1 },
        [],
        item.issues,
      );
      expect(result.goldLocateFailures).toEqual([]);
    }
  });

  test("rules-only copilot locates planted deterministic issues", async () => {
    const result = await createReview(
      { title: article.title, body: article.body },
      new FixtureReviewModel([]),
    );
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((finding) => {
      const text = finding.source_span.field === "title" ? result.article.title : result.article.body;
      return text.slice(finding.source_span.start_offset, finding.source_span.end_offset) === finding.source_span.quoted_text;
    })).toBe(true);
    const quotes = result.findings.map((item) => item.source_span.quoted_text);
    expect(quotes.some((item) => item.includes("座谈谈会") || item === "座谈谈会")).toBe(true);
  });
});
