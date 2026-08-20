import http from "node:http";
import https from "node:https";

import { canonicalizeProviderEndpoint, providerAccountBoundaryId } from "@/lib/server/benchmark/holdout/provider-identity";
import { OFFICIAL_BENCHMARK_PROVIDER } from "@/lib/server/llm/provenance";

export const CANONICAL_PROVIDER_REQUEST_BOUNDARY = "CANONICAL_PROVIDER_REQUEST_BOUNDARY";

export type CanonicalProviderRequestObservation = {
  url: string;
  origin: string;
  account_boundary_id: string | null;
};

function requestUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === "string" || input instanceof URL) {
    return String(input);
  }
  return input.url;
}

function headerRecord(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        result[String(entry[0]).toLowerCase()] = String(entry[1]);
      }
    }
    return result;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === "string") {
        result[key.toLowerCase()] = value;
      }
    }
  }
  return result;
}

function accountIdFromAuthorization(headers: unknown): string | null {
  const authorization = headerRecord(headers).authorization;
  if (!authorization) {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return null;
  }
  return providerAccountBoundaryId(OFFICIAL_BENCHMARK_PROVIDER, token);
}

function observeRequest(url: string, headers: unknown): CanonicalProviderRequestObservation {
  const parsed = new URL(url);
  return {
    url,
    origin: canonicalizeProviderEndpoint(parsed.origin),
    account_boundary_id: accountIdFromAuthorization(headers),
  };
}

export function installCanonicalProviderRequestProbe(): {
  requests: CanonicalProviderRequestObservation[];
  restore: () => void;
} {
  const requests: CanonicalProviderRequestObservation[] = [];
  const originalFetch = globalThis.fetch;
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;

  if (typeof originalFetch === "function") {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrlFromFetchInput(input);
      const headers =
        init?.headers ?? (typeof input === "object" && !(input instanceof URL) ? input.headers : undefined);
      const observed = observeRequest(url, headers);
      requests.push(observed);
      throw new Error(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY} ${observed.origin}`);
    }) as typeof fetch;
  }

  https.request = function patchedHttpsRequest(...args: Parameters<typeof https.request>) {
    const first = args[0];
    let url = "";
    let headers: unknown;
    if (typeof first === "string" || first instanceof URL) {
      url = String(first);
      headers = typeof args[1] === "object" ? (args[1] as { headers?: unknown }).headers : undefined;
    } else if (first && typeof first === "object") {
      const options = first as {
        protocol?: string;
        hostname?: string;
        host?: string;
        path?: string;
        href?: string;
        headers?: unknown;
      };
      headers = options.headers;
      url = options.href
        ?? `${options.protocol ?? "https:"}//${options.hostname ?? options.host ?? ""}${options.path ?? ""}`;
    }
    if (url) {
      const observed = observeRequest(url, headers);
      requests.push(observed);
      throw new Error(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY} ${observed.origin}`);
    }
    throw new Error(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY} unparseable`);
  } as typeof https.request;

  http.request = function patchedHttpRequest(...args: Parameters<typeof http.request>) {
    const first = args[0];
    const url = typeof first === "string" || first instanceof URL ? String(first) : "";
    if (url) {
      const observed = observeRequest(url, undefined);
      requests.push(observed);
    }
    throw new Error(`${CANONICAL_PROVIDER_REQUEST_BOUNDARY} ${url || "http"}`);
  } as typeof http.request;

  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
      https.request = originalHttpsRequest;
      http.request = originalHttpRequest;
    },
  };
}
