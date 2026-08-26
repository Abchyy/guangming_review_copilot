export type { SearchProvider } from "./search-provider";
export type { DomainAllowlistByCategory } from "./domain-allowlist";
export type { PlanWebEvidenceQueriesInput } from "./query-policy";
export type {
  FakeEvidenceSeed,
  FakeSearchBehavior,
  FakeSearchProviderOptions,
} from "./fake-provider";
export type { WebEvidenceCollectorOptions } from "./collector";
export type { EnvLike, TavilySearchProviderOptions } from "./tavily-provider";

export { DEFAULT_DOMAIN_ALLOWLIST, isAllowedWebEvidenceUrl } from "./domain-allowlist";
export { SearchProviderFailureError, SearchProviderTimeoutError } from "./errors";
export {
  DEFAULT_FAKE_EVIDENCE_CATALOG,
  FAKE_OFFLINE_PROVIDER_ID,
  FakeSearchProvider,
} from "./fake-provider";
export {
  HIGH_RISK_FINDING_CATEGORIES,
  WEB_EVIDENCE_FACT_PRIORITY,
  factsFromFindings,
  isHighRiskFindingType,
  planWebEvidenceQueries,
} from "./query-policy";
export { minimizeFactClaim, normalizeFactClaim } from "./privacy";
export {
  createWebEvidenceCollector,
  createWebEvidenceCollectorFromEnv,
} from "./collector";
export {
  DEFAULT_TAVILY_TIMEOUT_MS,
  TAVILY_CHUNKS_PER_SOURCE,
  TAVILY_MAX_EXCERPT_CHARS,
  TAVILY_PROVIDER_ID,
  TAVILY_SEARCH_URL,
  TavilySearchProvider,
  buildTavilySearchRequest,
  createTavilySearchProviderFromEnv,
  getTavilyApiKey,
  isWebEvidenceEnabled,
  sourceMetadataForUrl,
} from "./tavily-provider";
