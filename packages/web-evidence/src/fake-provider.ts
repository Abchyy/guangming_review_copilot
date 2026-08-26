import type { WebEvidenceItem, WebEvidenceQuery, WebEvidenceResult } from "@grc/contracts";
import {
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  parseWebEvidenceResult,
} from "@grc/contracts";

import { SearchProviderFailureError, SearchProviderTimeoutError } from "./errors";
import { isAllowedWebEvidenceUrl } from "./domain-allowlist";
import { normalizeFactClaim } from "./privacy";
import type { SearchProvider } from "./search-provider";

export type FakeEvidenceSeed = Omit<WebEvidenceItem, "retrieved_at">;

export type FakeSearchBehavior = "success" | "empty" | "timeout" | "failure";

export type FakeSearchProviderOptions = {
  catalog?: Record<string, readonly FakeEvidenceSeed[]>;
  extraItems?: readonly FakeEvidenceSeed[];
  behavior?: FakeSearchBehavior;
  behaviorFor?: (query: WebEvidenceQuery) => FakeSearchBehavior | undefined;
  now?: () => Date;
};

export const FAKE_OFFLINE_PROVIDER_ID = "fake-offline";

export const DEFAULT_FAKE_EVIDENCE_CATALOG: Record<string, FakeEvidenceSeed[]> = {
  "市教育局局长王海涛": [
    {
      source_name: "中国政府网",
      url: "https://www.gov.cn/example/wanghaitao",
      title: "市教育局局长王海涛出席基础教育座谈会",
      excerpt: "市教育局党委书记、局长王海涛出席会议并讲话。",
      published_or_version_date: "2026-01-15",
      source_tier: "official",
    },
    {
      source_name: "新华网",
      url: "https://www.news.cn/example/wanghaitao",
      title: "王海涛：抓好开学工作",
      excerpt: "王海涛要求各地做好开学准备。",
      published_or_version_date: "2026-01-16",
      source_tier: "authoritative",
    },
    {
      source_name: "人民网",
      url: "https://www.people.com.cn/example/wanghaitao",
      title: "地方教育部门负责人动态",
      excerpt: "公开报道中的负责人为市教育局局长王海涛。",
      published_or_version_date: "2026-01-17",
      source_tier: "authoritative",
    },
    {
      source_name: "百科镜像",
      url: "https://example.invalid/wiki/wanghaitao",
      title: "非白名单镜像页",
      excerpt: "此条用于验证 allowlist 过滤，不得进入结果。",
      published_or_version_date: "2020-01-01",
      source_tier: "unknown",
    },
  ],
  "市教育局": [
    {
      source_name: "中国政府网",
      url: "https://www.gov.cn/example/edu-bureau",
      title: "地方教育行政部门名称",
      excerpt: "地方教育行政部门常用名称为市教育局。",
      published_or_version_date: "2024-01-01",
      source_tier: "official",
    },
  ],
  "教育强国建设规划纲要": [
    {
      source_name: "教育部",
      url: "https://www.moe.gov.cn/example/edu-outline-2024",
      title: "教育强国建设规划纲要（2024－2035年）",
      excerpt: "正式文件名称使用2024－2035年。",
      published_or_version_date: "2024-01-01",
      source_tier: "official",
    },
    {
      source_name: "人民网",
      url: "https://www.people.com.cn/example/edu-outline",
      title: "转载：教育强国建设规划纲要",
      excerpt: "新闻转载不是政策法规类别的默认权威域名。",
      published_or_version_date: "2024-01-02",
      source_tier: "authoritative",
    },
  ],
  "义务教育阶段在校生": [
    {
      source_name: "国家统计局",
      url: "https://www.stats.gov.cn/example/enrollment",
      title: "义务教育阶段在校生统计口径",
      excerpt: "统计部门公布的义务教育阶段在校生数据需核对应年度公报。",
      published_or_version_date: "2025-12-31",
      source_tier: "official",
    },
  ],
};

/**
 * Deterministic offline SearchProvider. Results are fixture-backed and always
 * labeled fake_offline. This adapter never performs network I/O.
 */
export class FakeSearchProvider implements SearchProvider {
  readonly id = FAKE_OFFLINE_PROVIDER_ID;
  readonly kind = "fake_offline" as const;
  private readonly catalog: Record<string, readonly FakeEvidenceSeed[]>;
  private readonly extraItems: readonly FakeEvidenceSeed[];
  private readonly behavior: FakeSearchBehavior;
  private readonly behaviorFor?: (query: WebEvidenceQuery) => FakeSearchBehavior | undefined;
  private readonly now: () => Date;

  constructor(options: FakeSearchProviderOptions = {}) {
    this.catalog = options.catalog ?? DEFAULT_FAKE_EVIDENCE_CATALOG;
    this.extraItems = options.extraItems ?? [];
    this.behavior = options.behavior ?? "success";
    this.behaviorFor = options.behaviorFor;
    this.now = options.now ?? (() => new Date());
  }

  search(query: WebEvidenceQuery, options?: { signal?: AbortSignal }): Promise<WebEvidenceResult> {
    if (options?.signal?.aborted) {
      return Promise.reject(new SearchProviderTimeoutError());
    }
    const behavior = this.behaviorFor?.(query) ?? this.behavior;
    if (behavior === "timeout") {
      return Promise.reject(new SearchProviderTimeoutError());
    }
    if (behavior === "failure") {
      return Promise.reject(new SearchProviderFailureError());
    }

    const retrievedAt = this.now().toISOString();
    const seeds =
      behavior === "empty" ? [] : [...matchCatalog(this.catalog, query.query_text), ...this.extraItems];
    const evidence = seeds
      .filter((item) => isAllowedWebEvidenceUrl(item.url, query.allowed_domains))
      .slice(0, query.max_results)
      .map((item) => ({ ...item, retrieved_at: retrievedAt }))
      .sort((left, right) => left.url.localeCompare(right.url));

    if (evidence.length === 0) {
      return Promise.resolve(
        parseWebEvidenceResult({
          evidence: [],
          status: "unverified",
          error_class: "not_found",
          message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
          provenance: this.provenance(query, retrievedAt),
        }),
      );
    }

    return Promise.resolve(
      parseWebEvidenceResult({
        evidence,
        status: "retrieved",
        error_class: "none",
        message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
        provenance: this.provenance(query, retrievedAt),
      }),
    );
  }

  private provenance(query: WebEvidenceQuery, retrievedAt: string) {
    return {
      provider_id: this.id,
      provider_kind: this.kind,
      live_network: false as const,
      retrieved_at: retrievedAt,
      query_text: query.query_text,
      fact_category: query.fact_category,
    };
  }
}

function matchCatalog(
  catalog: Record<string, readonly FakeEvidenceSeed[]>,
  queryText: string,
): FakeEvidenceSeed[] {
  const needle = normalizeFactClaim(queryText);
  const matches = Object.keys(catalog)
    .filter((key) => {
      const normalizedKey = normalizeFactClaim(key);
      return needle.includes(normalizedKey) || normalizedKey.includes(needle);
    })
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const best = matches[0];
  return best ? [...(catalog[best] ?? [])] : [];
}
