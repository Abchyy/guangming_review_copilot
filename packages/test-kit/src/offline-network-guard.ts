import http from "node:http";
import https from "node:https";

function hostnameOf(url: string): string | null {
  try {
    return new URL(url, "http://localhost").hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "localhost.") {
    return true;
  }
  if (hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  if (hostname.startsWith("::ffff:")) {
    return isLoopbackHostname(hostname.slice("::ffff:".length));
  }
  const ipv4 = hostname.match(/^127(?:\.(\d{1,3})){3}$/);
  if (!ipv4) {
    return false;
  }
  return hostname.split(".").every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function assertOfflineUrl(url: string): void {
  const hostname = hostnameOf(url);
  if (hostname && isLoopbackHostname(hostname)) {
    return;
  }
  const target = hostname ?? url;
  throw new Error(
    `Offline tests blocked an external model API call to ${target}. Use npm run test:dev-live, npm run test:locked, or npm run test:live-smoke with explicit opt-in.`,
  );
}

function requestUrl(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    return String(first);
  }
  if (first && typeof first === "object") {
    const options = first as {
      protocol?: string;
      hostname?: string;
      host?: string;
      path?: string;
      href?: string;
    };
    if (options.href) {
      return options.href;
    }
    const host = options.hostname ?? options.host ?? "";
    if (host) {
      return `${options.protocol ?? "https:"}//${host}${options.path ?? ""}`;
    }
  }
  return "";
}

function wrapRequest<T extends typeof https.request>(original: T): T {
  return function patchedRequest(this: unknown, ...args: Parameters<T>) {
    const url = requestUrl(args);
    if (!url) {
      throw new Error(
        "Offline tests blocked an unparseable network request. Use npm run test:dev-live, npm run test:locked, or npm run test:live-smoke with explicit opt-in.",
      );
    }
    assertOfflineUrl(url);
    return original.apply(this, args);
  } as T;
}

export function installOfflineNetworkGuard(): void {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url;
      assertOfflineUrl(url);
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  http.request = wrapRequest(http.request);
  https.request = wrapRequest(https.request);
  http.get = wrapRequest(http.get);
  https.get = wrapRequest(https.get);
}
