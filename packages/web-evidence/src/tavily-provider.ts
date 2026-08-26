import type {
  WebEvidenceItem,
  WebEvidenceQuery,
  WebEvidenceResult,
  WebEvidenceSourceTier,
} from "@grc/contracts";
import {
  WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  parseWebEvidenceResult,
} from "@grc/contracts";

import { isAllowedWebEvidenceUrl } from "./domain-allowlist";
import { SearchProviderFailureError, SearchProviderTimeoutError } from "./errors";
import type { SearchProvider } from "./search-provider";

export const TAVILY_PROVIDER_ID = "tavily";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const DEFAULT_TAVILY_TIMEOUT_MS = 8_000;
export const TAVILY_MAX_EXCERPT_CHARS = 240;
export const TAVILY_CHUNKS_PER_SOURCE = 1;

const EXACT_SOURCE_METADATA: Readonly<Record<string, { name: string; tier: WebEvidenceSourceTier }>> = {
  "gov.cn": { name: "中国政府网", tier: "official" },
  "moe.gov.cn": { name: "教育部", tier: "official" },
  "stats.gov.cn": { name: "国家统计局", tier: "official" },
  "news.cn": { name: "新华网", tier: "authoritative" },
  "xinhuanet.com": { name: "新华网", tier: "authoritative" },
  "people.com.cn": { name: "人民网", tier: "authoritative" },
};

const PUBLISHER_SUFFIXES: ReadonlyArray<{ domain: string; name: string; tier: WebEvidenceSourceTier }> = [
  { domain: "news.cn", name: "新华网", tier: "authoritative" },
  { domain: "xinhuanet.com", name: "新华网", tier: "authoritative" },
  { domain: "people.com.cn", name: "人民网", tier: "authoritative" },
];

export type EnvLike = Record<string, string | undefined>;

export type TavilySearchProviderOptions = {
  apiKey: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
};

type TavilySearchRequest = {
  query: string;
  max_results: number;
  search_depth: "basic";
  chunks_per_source: number;
  include_answer: false;
  include_raw_content: false;
  include_images: false;
  include_domains: string[];
  language?: string;
  country?: string;
};

export function getTavilyApiKey(env: EnvLike = process.env): string | undefined {
  const value = env.TAVILY_API_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function isWebEvidenceEnabled(env: EnvLike = process.env): boolean {
  return env.WEB_EVIDENCE_ENABLED?.trim() === "true";
}

export function createTavilySearchProviderFromEnv(
  env: EnvLike = process.env,
  options: Omit<TavilySearchProviderOptions, "apiKey"> = {},
): TavilySearchProvider | null {
  const apiKey = getTavilyApiKey(env);
  if (!apiKey || !isWebEvidenceEnabled(env)) {
    return null;
  }
  return new TavilySearchProvider({ ...options, apiKey });
}

/**
 * Live SearchProvider for Tavily. Server-side only: enabled when
 * WEB_EVIDENCE_ENABLED=true and TAVILY_API_KEY is set. Never requests full
 * page content, and never keeps the raw vendor payload.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly id = TAVILY_PROVIDER_ID;
  readonly kind = "live" as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TavilySearchProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new SearchProviderFailureError("TAVILY_API_KEY is missing");
    }
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TAVILY_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: WebEvidenceQuery): Promise<WebEvidenceResult> {
    const retrievedAt = this.now().toISOString();
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new SearchProviderTimeoutError());
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.fetchImpl(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildTavilySearchRequest(query)),
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!response.ok) {
        throw new SearchProviderFailureError();
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SearchProviderFailureError();
      }
      return mapTavilyPayload(query, payload, this.id, retrievedAt);
    } catch (error) {
      if (error instanceof SearchProviderTimeoutError) {
        throw error;
      }
      if (error instanceof SearchProviderFailureError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new SearchProviderTimeoutError();
      }
      throw new SearchProviderFailureError();
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}

export function buildTavilySearchRequest(query: WebEvidenceQuery): TavilySearchRequest {
  const request: TavilySearchRequest = {
    query: query.query_text,
    max_results: clampResultLimit(query.max_results),
    search_depth: "basic",
    chunks_per_source: TAVILY_CHUNKS_PER_SOURCE,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_domains: includeDomainsFor(query.allowed_domains),
  };
  const language = tavilyLanguageOf(query.language);
  if (language) {
    request.language = language;
  }
  const country = tavilyCountryOf(query.region);
  if (country) {
    request.country = country;
  }
  return request;
}

function mapTavilyPayload(
  query: WebEvidenceQuery,
  payload: unknown,
  providerId: string,
  retrievedAt: string,
): WebEvidenceResult {
  const rows = tavilyResultRows(payload);
  const evidence = rows
    .map((row) => mapTavilyItem(row, query, retrievedAt))
    .filter((item): item is WebEvidenceItem => item != null)
    .slice(0, clampResultLimit(query.max_results));

  if (evidence.length === 0) {
    return parseWebEvidenceResult({
      evidence: [],
      status: "unverified",
      error_class: "not_found",
      message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
      provenance: {
        provider_id: providerId,
        provider_kind: "live",
        live_network: true,
        retrieved_at: retrievedAt,
        query_text: query.query_text,
        fact_category: query.fact_category,
      },
    });
  }

  return parseWebEvidenceResult({
    evidence,
    status: "retrieved",
    error_class: "none",
    message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
    provenance: {
      provider_id: providerId,
      provider_kind: "live",
      live_network: true,
      retrieved_at: retrievedAt,
      query_text: query.query_text,
      fact_category: query.fact_category,
    },
  });
}

function tavilyResultRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.results)) {
    throw new SearchProviderFailureError();
  }
  const rows: Record<string, unknown>[] = [];
  for (const item of record.results) {
    const row = asRecord(item);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

function mapTavilyItem(
  row: Record<string, unknown>,
  query: WebEvidenceQuery,
  retrievedAt: string,
): WebEvidenceItem | null {
  const url = readNonEmptyString(row.url);
  const title = readNonEmptyString(row.title);
  const excerpt = shortExcerpt(readNonEmptyString(row.content) ?? "");
  if (!url || !title || !excerpt) {
    return null;
  }
  if (!isAllowedWebEvidenceUrl(url, query.allowed_domains)) {
    return null;
  }
  const source = sourceMetadataForUrl(url);
  return {
    source_name: source.name,
    url,
    title,
    excerpt,
    published_or_version_date: publishedDateOf(row),
    retrieved_at: retrievedAt,
    source_tier: source.tier,
  };
}

export function sourceMetadataForUrl(url: string): { name: string; tier: WebEvidenceSourceTier } {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { name: "unknown", tier: "unknown" };
  }
  const exact = EXACT_SOURCE_METADATA[hostname];
  if (exact) {
    return exact;
  }
  for (const entry of PUBLISHER_SUFFIXES) {
    if (hostname.endsWith(`.${entry.domain}`)) {
      return { name: entry.name, tier: entry.tier };
    }
  }
  if (hostname.endsWith(".gov.cn")) {
    return { name: hostname, tier: "official" };
  }
  return { name: hostname || "unknown", tier: "unknown" };
}

function publishedDateOf(row: Record<string, unknown>): string | null {
  const raw = row.published_date ?? row.published_at;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shortExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= TAVILY_MAX_EXCERPT_CHARS) {
    return normalized;
  }
  return normalized.slice(0, TAVILY_MAX_EXCERPT_CHARS).trim();
}

function includeDomainsFor(allowedDomains: readonly string[]): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const domain of allowedDomains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized || normalized.includes("*") || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    domains.push(normalized);
  }
  return domains;
}

function tavilyLanguageOf(language: string | undefined): string | undefined {
  if (!language) {
    return undefined;
  }
  const normalized = language.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "zh" || normalized === "zh-cn" || normalized === "zh-hans") {
    return "zh-cn";
  }
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function tavilyCountryOf(region: string | undefined): string | undefined {
  if (!region) {
    return undefined;
  }
  const normalized = region.trim().toLowerCase();
  if (normalized === "cn" || normalized === "chn" || normalized === "china") {
    return "china";
  }
  return undefined;
}

function clampResultLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) {
    return WEB_EVIDENCE_MAX_RESULTS_PER_QUERY;
  }
  return Math.min(Math.floor(requested), WEB_EVIDENCE_MAX_RESULTS_PER_QUERY);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}
