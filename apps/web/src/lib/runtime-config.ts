export const RUNTIME_SESSION_COOKIE = "grc_runtime_sid";

export const RUNTIME_KEY_MAX_LENGTH = 512;

export type RuntimeKeySource = "session" | "environment" | "missing";

export type RuntimeProviderStatus = {
  configured: boolean;
  source: RuntimeKeySource;
};

export type RuntimeConfigStatus = {
  deepseek: RuntimeProviderStatus;
  tavily: RuntimeProviderStatus;
  capabilities: {
    real_review: boolean;
    web_evidence: boolean;
  };
};

const KEY_SOURCES = new Set<RuntimeKeySource>(["session", "environment", "missing"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderStatus(value: unknown): value is RuntimeProviderStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.configured === "boolean" &&
    typeof value.source === "string" &&
    KEY_SOURCES.has(value.source as RuntimeKeySource)
  );
}

export function isRuntimeConfigStatus(value: unknown): value is RuntimeConfigStatus {
  if (!isRecord(value) || !isRecord(value.capabilities)) {
    return false;
  }
  return (
    isProviderStatus(value.deepseek) &&
    isProviderStatus(value.tavily) &&
    typeof value.capabilities.real_review === "boolean" &&
    typeof value.capabilities.web_evidence === "boolean"
  );
}

export function missingRuntimeConfigStatus(): RuntimeConfigStatus {
  return {
    deepseek: { configured: false, source: "missing" },
    tavily: { configured: false, source: "missing" },
    capabilities: {
      real_review: false,
      web_evidence: false,
    },
  };
}
