import type {
  WebEvidenceCollectInput,
  WebEvidenceCollector,
  WebEvidenceErrorClass,
  WebEvidenceQuery,
  WebEvidenceResult,
  WebEvidenceRun,
} from "@grc/contracts";
import {
  WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
  WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  parseWebEvidenceResult,
  parseWebEvidenceRun,
} from "@grc/contracts";

import {
  DEFAULT_DOMAIN_ALLOWLIST,
  isAllowedWebEvidenceUrl,
  type DomainAllowlistByCategory,
} from "./domain-allowlist";
import { SearchProviderFailureError, SearchProviderTimeoutError } from "./errors";
import { factsFromFindings, planWebEvidenceQueries } from "./query-policy";
import type { SearchProvider } from "./search-provider";
import { createTavilySearchProviderFromEnv, type EnvLike } from "./tavily-provider";

export type WebEvidenceCollectorOptions = {
  allowlist?: DomainAllowlistByCategory;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  language?: string;
  region?: string;
  now?: () => Date;
  env?: EnvLike;
};

export function createWebEvidenceCollectorFromEnv(
  options: WebEvidenceCollectorOptions = {},
): WebEvidenceCollector | null {
  const provider = createTavilySearchProviderFromEnv(options.env, {
    now: options.now,
  });
  if (!provider) {
    return null;
  }
  return createWebEvidenceCollector(provider, options);
}

export function createWebEvidenceCollector(
  provider: SearchProvider,
  options: WebEvidenceCollectorOptions = {},
): WebEvidenceCollector {
  const allowlist = options.allowlist ?? DEFAULT_DOMAIN_ALLOWLIST;
  const now = options.now ?? (() => new Date());

  return {
    async collect(input: WebEvidenceCollectInput): Promise<WebEvidenceRun> {
      const facts = factsFromFindings(input.findings);
      const queries = planWebEvidenceQueries({
        facts,
        article: input.article,
        allowlist,
        language: input.language ?? options.language,
        region: input.region ?? options.region,
        maxQueries: options.maxQueries ?? WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
        maxResultsPerQuery: options.maxResultsPerQuery ?? WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
      });
      const results: WebEvidenceResult[] = [];
      let started = 0;
      for (const query of queries) {
        if (input.signal?.aborted) {
          break;
        }
        started += 1;
        results.push(await searchSafely(provider, query, now, input.signal));
      }
      return parseWebEvidenceRun({
        enabled: true,
        query_count: started,
        results,
      });
    },
  };
}

function swallowLater(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined,
  );
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    swallowLater(work);
    return Promise.resolve().then(onAbort);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      apply();
    };
    const abort = () => {
      swallowLater(work);
      finish(() => {
        try {
          resolve(onAbort());
        } catch (error) {
          reject(error);
        }
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function searchSafely(
  provider: SearchProvider,
  query: WebEvidenceQuery,
  now: () => Date,
  signal?: AbortSignal,
): Promise<WebEvidenceResult> {
  try {
    const raw = await raceAbort(provider.search(query, { signal }), signal, () => {
      throw new SearchProviderTimeoutError();
    });
    return sanitizeProviderResult(provider, query, raw, now);
  } catch (error) {
    return unverifiedResult(provider, query, classifyProviderError(error), now);
  }
}

function sanitizeProviderResult(
  provider: SearchProvider,
  query: WebEvidenceQuery,
  raw: WebEvidenceResult,
  now: () => Date,
): WebEvidenceResult {
  if (
    raw.provenance.provider_kind === "fake_offline" &&
    (raw.provenance.live_network || raw.provenance.provider_kind !== provider.kind)
  ) {
    return unverifiedResult(provider, query, "provider_failure", now);
  }
  if (raw.provenance.provider_id !== provider.id || raw.provenance.provider_kind !== provider.kind) {
    return unverifiedResult(provider, query, "provider_failure", now);
  }
  if (raw.status === "unverified") {
    return parseWebEvidenceResult({
      evidence: [],
      status: "unverified",
      error_class: raw.error_class === "none" ? "provider_failure" : raw.error_class,
      message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
      provenance: {
        ...raw.provenance,
        live_network: provider.kind === "live" ? raw.provenance.live_network : false,
        query_text: query.query_text,
        fact_category: query.fact_category,
      },
    });
  }
  const evidence = raw.evidence
    .filter((item) => isAllowedWebEvidenceUrl(item.url, query.allowed_domains))
    .slice(0, query.max_results);
  if (evidence.length === 0) {
    return unverifiedResult(provider, query, "not_found", now, {
      liveNetwork: provider.kind === "live",
    });
  }
  return parseWebEvidenceResult({
    ...raw,
    evidence,
    status: "retrieved",
    error_class: "none",
    message: raw.message,
    provenance: {
      ...raw.provenance,
      live_network: provider.kind === "live" ? raw.provenance.live_network : false,
      query_text: query.query_text,
      fact_category: query.fact_category,
    },
  });
}

function classifyProviderError(error: unknown): WebEvidenceErrorClass {
  if (error instanceof SearchProviderTimeoutError) {
    return "timeout";
  }
  if (error instanceof SearchProviderFailureError) {
    return "provider_failure";
  }
  return "provider_failure";
}

function unverifiedResult(
  provider: SearchProvider,
  query: WebEvidenceQuery,
  errorClass: WebEvidenceErrorClass,
  now: () => Date,
  options: { liveNetwork?: boolean } = {},
): WebEvidenceResult {
  const liveSuccess = provider.kind === "live" && options.liveNetwork === true;
  return parseWebEvidenceResult({
    evidence: [],
    status: "unverified",
    error_class: errorClass,
    message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    provenance: {
      provider_id: provider.id,
      provider_kind: liveSuccess ? "live" : provider.kind === "live" ? "unavailable" : provider.kind,
      live_network: liveSuccess,
      retrieved_at: now().toISOString(),
      query_text: query.query_text,
      fact_category: query.fact_category,
    },
  });
}
