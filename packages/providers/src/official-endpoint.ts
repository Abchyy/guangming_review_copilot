import { createHash } from "node:crypto";

import { ReviewProviderError } from "@grc/contracts";

import { getDeepSeekApiKey, getDeepSeekBaseUrl } from "./config";

export function canonicalizeProviderEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ReviewProviderError("Provider endpoint is empty");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ReviewProviderError("Provider endpoint is not a valid URL");
  }
  if (url.username || url.password) {
    throw new ReviewProviderError("Provider endpoint must not embed credentials");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function providerAccountBoundaryId(provider: string, credential: string): string {
  const secret = credential.trim();
  if (secret.length === 0) {
    throw new ReviewProviderError("Provider account identity requires a non-empty credential");
  }
  return createHash("sha256")
    .update(`provider-account.v1:${provider}:${secret}`, "utf8")
    .digest("hex");
}

export function observeOfficialProviderEndpoint(): string {
  const canonical = canonicalizeProviderEndpoint(getDeepSeekBaseUrl());
  if (!canonical.startsWith("https://")) {
    throw new ReviewProviderError("Official provider endpoint must be https");
  }
  return canonical;
}

export function observeOfficialAccountBoundaryId(): string {
  const credential = getDeepSeekApiKey();
  if (!credential) {
    throw new ReviewProviderError("Official provider account identity requires DEEPSEEK_API_KEY");
  }
  return providerAccountBoundaryId("deepseek", credential);
}
