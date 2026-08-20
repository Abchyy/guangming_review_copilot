import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { sha256Text } from "@/lib/server/benchmark/holdout/identity";
import { getDeepSeekApiKey, getDeepSeekBaseUrl } from "@/lib/server/config";
import { OFFICIAL_BENCHMARK_PROVIDER } from "@/lib/server/llm/provenance";

const ACCOUNT_IDENTITY_DOMAIN = "holdout-provider-account.v1";

export type OfficialProviderBoundary = {
  provider_endpoint: string;
  account_boundary_id: string;
};

export function canonicalizeProviderEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HoldoutProtocolError("Provider endpoint is empty");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HoldoutProtocolError("Provider endpoint is not a valid URL");
  }
  if (url.username || url.password) {
    throw new HoldoutProtocolError("Provider endpoint must not embed credentials");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function providerAccountBoundaryId(provider: string, credential: string): string {
  const secret = credential.trim();
  if (secret.length === 0) {
    throw new HoldoutProtocolError("Provider account identity requires a non-empty credential");
  }
  return sha256Text(`${ACCOUNT_IDENTITY_DOMAIN}:${provider}:${secret}`);
}

export function observeOfficialProviderEndpoint(): string {
  const canonical = canonicalizeProviderEndpoint(getDeepSeekBaseUrl());
  if (!canonical.startsWith("https://")) {
    throw new HoldoutProtocolError("Official provider endpoint must be https");
  }
  return canonical;
}

export function observeOfficialAccountBoundaryId(): string {
  const credential = getDeepSeekApiKey();
  if (!credential) {
    throw new HoldoutProtocolError(
      "Official system freeze requires DEEPSEEK_API_KEY to bind provider account identity",
    );
  }
  return providerAccountBoundaryId(OFFICIAL_BENCHMARK_PROVIDER, credential);
}

export function observeOfficialProviderBoundary(): OfficialProviderBoundary {
  return {
    provider_endpoint: observeOfficialProviderEndpoint(),
    account_boundary_id: observeOfficialAccountBoundaryId(),
  };
}

export function assertArtifactContainsNoSecrets(value: unknown, secrets: Array<string | undefined>): void {
  const dumped = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && secret.length > 0 && dumped.includes(secret)) {
      throw new HoldoutProtocolError("Refusing to persist secret material in a freeze artifact");
    }
  }
}
