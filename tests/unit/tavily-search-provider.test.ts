import { describe, expect, test } from "vitest";

import type { WebEvidenceQuery } from "@grc/contracts";
import {
  WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
} from "@grc/contracts";
import {
  FAKE_OFFLINE_PROVIDER_ID,
  SearchProviderFailureError,
  SearchProviderTimeoutError,
  TAVILY_CHUNKS_PER_SOURCE,
  TAVILY_MAX_EXCERPT_CHARS,
  TAVILY_PROVIDER_ID,
  TAVILY_SEARCH_URL,
  TavilySearchProvider,
  buildTavilySearchRequest,
  createTavilySearchProviderFromEnv,
  createWebEvidenceCollector,
  createWebEvidenceCollectorFromEnv,
  getTavilyApiKey,
  isWebEvidenceEnabled,
  sourceMetadataForUrl,
} from "@grc/web-evidence";

const retrievedAt = "2026-08-26T08:00:00.000Z";

const query: WebEvidenceQuery = {
  query_text: "市教育局局长王海涛",
  fact_category: "person_title",
  allowed_domains: ["gov.cn", "news.cn", "people.com.cn"],
  language: "zh-CN",
  region: "CN",
  max_results: 3,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function providerWithFetch(
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): TavilySearchProvider {
  return new TavilySearchProvider({
    apiKey: "tvly-test-key",
    timeoutMs,
    now: () => new Date(retrievedAt),
    fetchImpl,
  });
}

describe("tavily env wiring", () => {
  test("live adapter stays off unless TAVILY_API_KEY and WEB_EVIDENCE_ENABLED=true", () => {
    expect(getTavilyApiKey({})).toBeUndefined();
    expect(getTavilyApiKey({ TAVILY_API_KEY: "   " })).toBeUndefined();
    expect(getTavilyApiKey({ NEXT_PUBLIC_TAVILY_API_KEY: "tvly-leaked" })).toBeUndefined();
    expect(isWebEvidenceEnabled({})).toBe(false);
    expect(isWebEvidenceEnabled({ WEB_EVIDENCE_ENABLED: "1" })).toBe(false);
    expect(isWebEvidenceEnabled({ WEB_EVIDENCE_ENABLED: "TRUE" })).toBe(false);
    expect(isWebEvidenceEnabled({ WEB_EVIDENCE_ENABLED: "true" })).toBe(true);
    expect(createTavilySearchProviderFromEnv({})).toBeNull();
    expect(createTavilySearchProviderFromEnv({ TAVILY_API_KEY: "tvly-dev-test" })).toBeNull();
    expect(
      createTavilySearchProviderFromEnv({ WEB_EVIDENCE_ENABLED: "true" }),
    ).toBeNull();
    expect(createWebEvidenceCollectorFromEnv({ env: {} })).toBeNull();
    expect(
      createWebEvidenceCollectorFromEnv({
        env: { TAVILY_API_KEY: "tvly-dev-test", WEB_EVIDENCE_ENABLED: "1" },
      }),
    ).toBeNull();
  });

  test("configured key and flag create a live provider rather than fake offline", () => {
    const provider = createTavilySearchProviderFromEnv({
      TAVILY_API_KEY: "tvly-dev-test",
      WEB_EVIDENCE_ENABLED: "true",
    });
    expect(provider).toBeInstanceOf(TavilySearchProvider);
    expect(provider?.id).toBe(TAVILY_PROVIDER_ID);
    expect(provider?.kind).toBe("live");
    expect(provider?.id).not.toBe(FAKE_OFFLINE_PROVIDER_ID);
    expect(provider?.kind).not.toBe("fake_offline");
  });
});

describe("tavily search request", () => {
  test("sends only the minimized fact query and vendor-safe search options", () => {
    const request = buildTavilySearchRequest({
      ...query,
      allowed_domains: ["gov.cn", "*.gov.cn", "news.cn", "people.com.cn"],
    });
    expect(request.query).toBe("市教育局局长王海涛");
    expect(request.max_results).toBe(WEB_EVIDENCE_MAX_RESULTS_PER_QUERY);
    expect(request.search_depth).toBe("basic");
    expect(request.chunks_per_source).toBe(TAVILY_CHUNKS_PER_SOURCE);
    expect(request.include_answer).toBe(false);
    expect(request.include_raw_content).toBe(false);
    expect(request.include_images).toBe(false);
    expect(request.language).toBe("zh-cn");
    expect(request.country).toBe("china");
    expect(request.include_domains).toEqual(["gov.cn", "news.cn", "people.com.cn"]);
    expect(request.include_domains.some((domain) => domain.includes("*"))).toBe(false);
    expect(Object.keys(request).sort()).toEqual([
      "chunks_per_source",
      "country",
      "include_answer",
      "include_domains",
      "include_images",
      "include_raw_content",
      "language",
      "max_results",
      "query",
      "search_depth",
    ]);
    expect(JSON.stringify(request)).not.toContain("article");
    expect(JSON.stringify(request)).not.toContain("*.");
  });
});

describe("tavily live provider", () => {
  test("keeps only title, url, short excerpt, date, and source tier", async () => {
    const longContent = `${"权威摘录".repeat(80)} 不得作为全文`;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(TAVILY_SEARCH_URL);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        max_results: number;
        chunks_per_source: number;
        include_raw_content: boolean;
        include_answer: boolean;
        language?: string;
        country?: string;
        include_domains: string[];
      };
      expect(body.query).toBe(query.query_text);
      expect(body.max_results).toBeLessThanOrEqual(WEB_EVIDENCE_MAX_RESULTS_PER_QUERY);
      expect(body.chunks_per_source).toBe(1);
      expect(body.include_raw_content).toBe(false);
      expect(body.include_answer).toBe(false);
      expect(body.language).toBe("zh-cn");
      expect(body.country).toBe("china");
      expect(body.include_domains.some((domain) => domain.includes("*"))).toBe(false);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer tvly-test-key");
      return jsonResponse({
        query: query.query_text,
        answer: "must-not-keep-answer",
        request_id: "must-not-keep-request-id",
        results: [
          {
            title: "市教育局局长王海涛出席基础教育座谈会",
            url: "https://www.gov.cn/example/wanghaitao",
            content: longContent,
            published_date: "2026-01-15",
            raw_content: "FULL_PAGE_BODY_MUST_NOT_BE_KEPT",
            score: 0.99,
          },
          {
            title: "非白名单镜像",
            url: "https://zh.wikipedia.org/wiki/wanghaitao",
            content: "不得进入结果",
            raw_content: "FULL_PAGE_BODY_MUST_NOT_BE_KEPT",
          },
          {
            title: "新华网报道",
            url: "https://www.news.cn/example/wanghaitao",
            content: "王海涛要求各地做好开学准备。",
            published_date: "2026-01-16",
          },
          {
            title: "人民网动态",
            url: "https://www.people.com.cn/example/wanghaitao",
            content: "公开报道中的负责人为市教育局局长王海涛。",
            published_date: "2026-01-17",
          },
          {
            title: "溢出的第四条",
            url: "https://www.gov.cn/example/overflow",
            content: "每查询最多三条。",
          },
        ],
      });
    };

    const result = await providerWithFetch(fetchImpl).search(query);
    expect(result.status).toBe("retrieved");
    expect(result.message).toBe(WEB_EVIDENCE_RETRIEVED_MESSAGE);
    expect(result.provenance.provider_id).toBe(TAVILY_PROVIDER_ID);
    expect(result.provenance.provider_kind).toBe("live");
    expect(result.provenance.live_network).toBe(true);
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence.every((item) => item.excerpt.length <= TAVILY_MAX_EXCERPT_CHARS)).toBe(
      true,
    );
    expect(result.evidence[0]).toEqual({
      source_name: "中国政府网",
      url: "https://www.gov.cn/example/wanghaitao",
      title: "市教育局局长王海涛出席基础教育座谈会",
      excerpt: longContent.replace(/\s+/g, " ").trim().slice(0, TAVILY_MAX_EXCERPT_CHARS).trim(),
      published_or_version_date: "2026-01-15",
      retrieved_at: retrievedAt,
      source_tier: "official",
    });
    expect(result.evidence.some((item) => item.url.includes("wikipedia"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("FULL_PAGE_BODY_MUST_NOT_BE_KEPT");
    expect(JSON.stringify(result)).not.toContain("must-not-keep-answer");
    expect(JSON.stringify(result)).not.toContain("must-not-keep-request-id");
    expect(JSON.stringify(result)).not.toContain("raw_content");
  });

  test("timeout, provider failure, and empty hits degrade to 未能外部核验", async () => {
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    await expect(providerWithFetch(hangingFetch, 20).search(query)).rejects.toBeInstanceOf(
      SearchProviderTimeoutError,
    );

    await expect(
      providerWithFetch(async () => jsonResponse({ error: "nope" }, 500)).search(query),
    ).rejects.toBeInstanceOf(SearchProviderFailureError);

    const empty = await providerWithFetch(
      async () => jsonResponse({ results: [] }),
    ).search(query);
    expect(empty.status).toBe("unverified");
    expect(empty.error_class).toBe("not_found");
    expect(empty.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(empty.evidence).toEqual([]);
    expect(empty.provenance.provider_kind).toBe("live");
    expect(empty.provenance.live_network).toBe(true);

    const collector = createWebEvidenceCollector(providerWithFetch(hangingFetch, 20), {
      now: () => new Date(retrievedAt),
    });
    const run = await collector.collect({
      article: {
        title: "我市召开基础教育高质量发展座谈会",
        body: "市教育局局长王海涛出席。",
        version: 1,
      },
      findings: [
        {
          type: "person",
          title: "职务待核验",
          reason: "人名与职务需外部核验。",
          source_span: {
            field: "body",
            start_offset: 0,
            end_offset: 9,
            quoted_text: "市教育局局长王海涛",
            paragraph_index: 0,
            article_version: 1,
          },
        },
      ],
    });
    expect(run.results[0]?.status).toBe("unverified");
    expect(run.results[0]?.error_class).toBe("timeout");
    expect(run.results[0]?.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(run.results[0]?.message).not.toBe("没有问题");
    expect(run.results[0]?.evidence).toEqual([]);
    expect(run.results[0]?.provenance.provider_kind).toBe("unavailable");
    expect(run.results[0]?.provenance.live_network).toBe(false);

    const emptyRun = await createWebEvidenceCollector(
      providerWithFetch(async () => jsonResponse({ results: [] })),
      { now: () => new Date(retrievedAt) },
    ).collect({
      article: {
        title: "我市召开基础教育高质量发展座谈会",
        body: "市教育局局长王海涛出席。",
        version: 1,
      },
      findings: [
        {
          type: "person",
          title: "职务待核验",
          reason: "人名与职务需外部核验。",
          source_span: {
            field: "body",
            start_offset: 0,
            end_offset: 9,
            quoted_text: "市教育局局长王海涛",
            paragraph_index: 0,
            article_version: 1,
          },
        },
      ],
    });
    expect(emptyRun.results[0]?.status).toBe("unverified");
    expect(emptyRun.results[0]?.error_class).toBe("not_found");
    expect(emptyRun.results[0]?.message).toBe(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(emptyRun.results[0]?.provenance.provider_kind).toBe("live");
    expect(emptyRun.results[0]?.provenance.live_network).toBe(true);
  });

  test("gov.cn subdomains keep distinct source names", () => {
    expect(sourceMetadataForUrl("https://www.gov.cn/example")).toEqual({
      name: "中国政府网",
      tier: "official",
    });
    expect(sourceMetadataForUrl("https://www.moe.gov.cn/example")).toEqual({
      name: "教育部",
      tier: "official",
    });
    expect(sourceMetadataForUrl("https://www.stats.gov.cn/example")).toEqual({
      name: "国家统计局",
      tier: "official",
    });
    expect(sourceMetadataForUrl("https://qingdao.gov.cn/example")).toEqual({
      name: "qingdao.gov.cn",
      tier: "official",
    });
    expect(sourceMetadataForUrl("https://jyj.gz.gov.cn/example")).toEqual({
      name: "jyj.gz.gov.cn",
      tier: "official",
    });
    expect(sourceMetadataForUrl("https://www.news.cn/example")).toEqual({
      name: "新华网",
      tier: "authoritative",
    });
  });

  test("does not call extract or crawl endpoints", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse({ results: [] });
    };
    await providerWithFetch(fetchImpl).search(query);
    expect(urls).toEqual([TAVILY_SEARCH_URL]);
    expect(urls.some((url) => url.includes("/extract") || url.includes("/crawl"))).toBe(false);
  });
});
