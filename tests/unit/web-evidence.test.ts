import { describe, expect, test } from "vitest";

import type {
  CanonicalArticle,
  Finding,
  FindingType,
  WebEvidenceItem,
  WebEvidenceQuery,
  WebEvidenceResult,
} from "@grc/contracts";
import {
  WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
  WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  parseWebEvidenceResult,
} from "@grc/contracts";
import {
  DEFAULT_DOMAIN_ALLOWLIST,
  FakeSearchProvider,
  SearchProviderFailureError,
  SearchProviderTimeoutError,
  createWebEvidenceCollector,
  factsFromFindings,
  isHighRiskFindingType,
  minimizeFactClaim,
  planWebEvidenceQueries,
  type SearchProvider,
} from "@grc/web-evidence";

const article: CanonicalArticle = {
  title: "我市召开基础教育高质量发展座谈会",
  body: "上周四（8月12日）召开座谈谈会。市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。本次座谈会由市教育委员会主办。要学习《教育强国建设规划纲要（2023－2035年）》。王强在总结时强调开学工作。另据通报义务教育阶段在校生共182万人。",
  version: 1,
};

const retrievedAt = "2026-08-26T08:00:00.000Z";

function findingOf(
  type: FindingType,
  quoted: string,
  title = "待核验事实",
): Pick<Finding, "type" | "title" | "reason" | "source_span"> {
  return {
    type,
    title,
    reason: "内部分析：仅供审校，不得外发。",
    source_span: {
      field: "body",
      start_offset: 0,
      end_offset: quoted.length,
      quoted_text: quoted,
      paragraph_index: 0,
      article_version: 1,
    },
  };
}

class RecordingProvider implements SearchProvider {
  readonly queries: WebEvidenceQuery[] = [];

  constructor(private readonly inner: SearchProvider) {}

  get id(): string {
    return this.inner.id;
  }

  get kind() {
    return this.inner.kind;
  }

  search(query: WebEvidenceQuery): Promise<WebEvidenceResult> {
    this.queries.push(query);
    return this.inner.search(query);
  }
}

class ScriptedProvider implements SearchProvider {
  readonly id = "fake-offline";
  readonly kind = "fake_offline" as const;

  constructor(private readonly items: Omit<WebEvidenceItem, "retrieved_at">[]) {}

  search(query: WebEvidenceQuery): Promise<WebEvidenceResult> {
    const evidence = this.items.map((item) => ({ ...item, retrieved_at: retrievedAt }));
    return Promise.resolve(
      parseWebEvidenceResult({
        evidence,
        status: "retrieved",
        error_class: "none",
        message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
        provenance: {
          provider_id: this.id,
          provider_kind: this.kind,
          live_network: false,
          retrieved_at: retrievedAt,
          query_text: query.query_text,
          fact_category: query.fact_category,
        },
      }),
    );
  }
}

describe("web evidence query policy", () => {
  test("high-risk finding types can trigger queries and low-risk types cannot", () => {
    expect(isHighRiskFindingType("person")).toBe(true);
    expect(isHighRiskFindingType("organization")).toBe(true);
    expect(isHighRiskFindingType("policy")).toBe(true);
    expect(isHighRiskFindingType("datetime")).toBe(true);
    expect(isHighRiskFindingType("number")).toBe(true);
    expect(isHighRiskFindingType("citation")).toBe(true);
    expect(isHighRiskFindingType("external_fact")).toBe(true);
    expect(isHighRiskFindingType("basic_text")).toBe(false);
    expect(isHighRiskFindingType("consistency")).toBe(false);

    const mixed = factsFromFindings([
      findingOf("person", "市教育局局长王海涛"),
      findingOf("basic_text", "座谈谈会"),
      findingOf("consistency", "在校生人数前后不一致"),
      findingOf("policy", "教育强国建设规划纲要（2023－2035年）"),
    ]);
    expect(mixed.map((item) => item.category)).toEqual([
      "person_title",
      "policy_regulation",
    ]);

    const queries = planWebEvidenceQueries({ facts: mixed, article });
    expect(queries).toHaveLength(2);
    expect(queries.every((item) => item.query_text.length > 0)).toBe(true);
    expect(queries.some((item) => item.query_text.includes("座谈谈会"))).toBe(false);
  });

  test("caps queries per article and results per query", async () => {
    const facts = factsFromFindings([
      findingOf("person", "市教育局局长王海涛"),
      findingOf("organization", "市教育局"),
      findingOf("policy", "教育强国建设规划纲要"),
      findingOf("datetime", "上周四（8月12日）"),
      findingOf("number", "义务教育阶段在校生共128万人"),
    ]);
    const queries = planWebEvidenceQueries({
      facts,
      article,
      maxQueries: 99,
      maxResultsPerQuery: 99,
    });
    expect(queries).toHaveLength(WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE);
    expect(queries.every((item) => item.max_results === WEB_EVIDENCE_MAX_RESULTS_PER_QUERY)).toBe(
      true,
    );

    const overflow = new ScriptedProvider(
      Array.from({ length: 8 }, (_, index) => ({
        source_name: "中国政府网",
        url: `https://www.gov.cn/example/item-${index}`,
        title: `条目${index}`,
        excerpt: "权威摘录",
        published_or_version_date: "2026-01-01",
        source_tier: "official" as const,
      })),
    );
    const collector = createWebEvidenceCollector(overflow, {
      now: () => new Date(retrievedAt),
    });
    const run = await collector.collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
    });
    expect(run.results[0]?.evidence).toHaveLength(WEB_EVIDENCE_MAX_RESULTS_PER_QUERY);
  });

  test("minimizes privacy risk and never sends the article, secrets, notes, or holdout", () => {
    expect(minimizeFactClaim(article.body, article)).toBeNull();
    expect(minimizeFactClaim(`${article.title}\n${article.body}`, article)).toBeNull();
    expect(minimizeFactClaim("sk-abcdefghijklmnopqrstuvwxyz", article)).toBeNull();
    expect(minimizeFactClaim("OPENAI_API_KEY=sk-live-secret", article)).toBeNull();
    expect(minimizeFactClaim("holdout gold: 王海涛职务", article)).toBeNull();
    expect(minimizeFactClaim("【内部批注】请核验王海涛职务", article)).toBeNull();
    expect(minimizeFactClaim("联系编辑 editor@example.com 核验王海涛")).toBe(
      "联系编辑 核验王海涛",
    );

    const queries = planWebEvidenceQueries({
      facts: [
        { category: "person_title", claim: article.body },
        { category: "person_title", claim: "内部批注：王海涛" },
        { category: "attribution", claim: "holdout pack id 12" },
        { category: "person_title", claim: "市教育局局长王海涛" },
      ],
      article,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.query_text).toBe("市教育局局长王海涛");
    expect(queries[0]?.query_text.includes(article.body)).toBe(false);
    expect(queries[0]?.query_text).not.toContain("sk-");
    expect(queries[0]?.query_text).not.toContain("holdout");
    expect(queries[0]?.query_text).not.toContain("内部批注");
  });

  test("attaches per-category domain allowlists instead of a hardcoded global list", () => {
    const queries = planWebEvidenceQueries({
      facts: [
        { category: "person_title", claim: "市教育局局长王海涛" },
        { category: "policy_regulation", claim: "教育强国建设规划纲要" },
      ],
      article,
    });
    const person = queries.find((item) => item.fact_category === "person_title");
    const policy = queries.find((item) => item.fact_category === "policy_regulation");
    expect(person?.allowed_domains).toEqual([...DEFAULT_DOMAIN_ALLOWLIST.person_title]);
    expect(policy?.allowed_domains).toEqual([...DEFAULT_DOMAIN_ALLOWLIST.policy_regulation]);
    expect(policy?.allowed_domains.includes("people.com.cn")).toBe(false);
  });
});

describe("web evidence fake provider and collector", () => {
  test("fake provider provenance stays offline and is not labeled live", async () => {
    const provider = new FakeSearchProvider({ now: () => new Date(retrievedAt) });
    const recorder = new RecordingProvider(provider);
    const collector = createWebEvidenceCollector(recorder, {
      now: () => new Date(retrievedAt),
    });
    const run = await collector.collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
    });

    expect(provider.kind).toBe("fake_offline");
    expect(run.results).toHaveLength(1);
    const result = run.results[0]!;
    expect(result.status).toBe("retrieved");
    expect(result.provenance.provider_id).toBe("fake-offline");
    expect(result.provenance.provider_kind).toBe("fake_offline");
    expect(result.provenance.live_network).toBe(false);
    expect(result.message).toBe(WEB_EVIDENCE_RETRIEVED_MESSAGE);
    expect(result.message).not.toContain("没有问题");
    expect(recorder.queries[0]?.query_text).toBe("市教育局局长王海涛");
    expect(result.evidence.every((item) => item.url.includes("gov.cn") || item.url.includes("news.cn") || item.url.includes("people.com.cn"))).toBe(true);
    expect(result.evidence.some((item) => item.url.includes("example.invalid"))).toBe(false);
  });

  test("collector drops URLs outside the category allowlist", async () => {
    const mixed = new ScriptedProvider([
      {
        source_name: "教育部",
        url: "https://www.moe.gov.cn/example/outline",
        title: "教育强国建设规划纲要（2024－2035年）",
        excerpt: "正式文件名称使用2024－2035年。",
        published_or_version_date: "2024-01-01",
        source_tier: "official",
      },
      {
        source_name: "维基镜像",
        url: "https://zh.wikipedia.org/wiki/example",
        title: "非白名单来源",
        excerpt: "不得进入政策核验结果。",
        published_or_version_date: "2024-01-01",
        source_tier: "unknown",
      },
      {
        source_name: "人民网",
        url: "https://www.people.com.cn/example/outline",
        title: "新闻转载",
        excerpt: "政策类别默认不允许新闻域名。",
        published_or_version_date: "2024-01-02",
        source_tier: "authoritative",
      },
    ]);
    const run = await createWebEvidenceCollector(mixed, {
      now: () => new Date(retrievedAt),
    }).collect({
      article,
      findings: [findingOf("policy", "教育强国建设规划纲要")],
    });
    expect(run.results[0]?.status).toBe("retrieved");
    expect(run.results[0]?.evidence).toHaveLength(1);
    expect(run.results[0]?.evidence[0]?.url).toContain("moe.gov.cn");
  });

  test("timeout, provider failure, and empty hits degrade to 未能外部核验", async () => {
    const timeoutRun = await createWebEvidenceCollector(
      new FakeSearchProvider({ behavior: "timeout", now: () => new Date(retrievedAt) }),
    ).collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
    });
    expect(timeoutRun.results[0]?.status).toBe("unverified");
    expect(timeoutRun.results[0]?.error_class).toBe("timeout");
    expect(timeoutRun.results[0]?.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(timeoutRun.results[0]?.evidence).toEqual([]);

    const failureRun = await createWebEvidenceCollector(
      new FakeSearchProvider({ behavior: "failure", now: () => new Date(retrievedAt) }),
    ).collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
    });
    expect(failureRun.results[0]?.error_class).toBe("provider_failure");
    expect(failureRun.results[0]?.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(failureRun.results[0]?.message).not.toBe("没有问题");

    const emptyRun = await createWebEvidenceCollector(
      new FakeSearchProvider({ behavior: "empty", now: () => new Date(retrievedAt) }),
    ).collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
    });
    expect(emptyRun.results[0]?.error_class).toBe("not_found");
    expect(emptyRun.results[0]?.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);

    await expect(
      new FakeSearchProvider({ behavior: "timeout" }).search({
        query_text: "市教育局局长王海涛",
        fact_category: "person_title",
        allowed_domains: ["gov.cn"],
        max_results: 3,
      }),
    ).rejects.toBeInstanceOf(SearchProviderTimeoutError);
    await expect(
      new FakeSearchProvider({ behavior: "failure" }).search({
        query_text: "市教育局局长王海涛",
        fact_category: "person_title",
        allowed_domains: ["gov.cn"],
        max_results: 3,
      }),
    ).rejects.toBeInstanceOf(SearchProviderFailureError);
  });

  test("low-risk-only articles issue zero queries", async () => {
    const recorder = new RecordingProvider(
      new FakeSearchProvider({ now: () => new Date(retrievedAt) }),
    );
    const run = await createWebEvidenceCollector(recorder).collect({
      article,
      findings: [
        findingOf("basic_text", "座谈谈会"),
        findingOf("consistency", "在校生人数前后不一致"),
      ],
    });
    expect(run.query_count).toBe(0);
    expect(run.results).toEqual([]);
    expect(recorder.queries).toEqual([]);
  });

  test("an already-aborted collect does not start search requests", async () => {
    const recorder = new RecordingProvider(
      new FakeSearchProvider({ now: () => new Date(retrievedAt) }),
    );
    const controller = new AbortController();
    controller.abort();
    const run = await createWebEvidenceCollector(recorder).collect({
      article,
      findings: [findingOf("person", "市教育局局长王海涛")],
      signal: controller.signal,
    });
    expect(run.query_count).toBe(0);
    expect(run.results).toEqual([]);
    expect(recorder.queries).toEqual([]);
  });

  test("starts the two planned searches concurrently and preserves query order", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const provider: SearchProvider = {
      id: "parallel-test",
      kind: "fake_offline",
      search(query) {
        started.push(query.query_text);
        return new Promise((resolve) => {
          releases.push(() =>
            resolve(
              parseWebEvidenceResult({
                evidence: [],
                status: "unverified",
                error_class: "not_found",
                message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
                provenance: {
                  provider_id: "parallel-test",
                  provider_kind: "fake_offline",
                  live_network: false,
                  retrieved_at: retrievedAt,
                  query_text: query.query_text,
                  fact_category: query.fact_category,
                },
              }),
            ),
          );
        });
      },
    };
    const collect = createWebEvidenceCollector(provider).collect({
      article,
      findings: [
        findingOf("person", "市教育局局长王海涛"),
        findingOf("policy", "教育强国建设规划纲要"),
      ],
    });

    await Promise.resolve();
    expect(started).toEqual(["市教育局局长王海涛", "教育强国建设规划纲要"]);
    expect(releases).toHaveLength(2);
    releases.forEach((release) => release());
    const run = await collect;
    expect(run.query_count).toBe(2);
    expect(run.results.map((item) => item.provenance.query_text)).toEqual(started);
  });
});
