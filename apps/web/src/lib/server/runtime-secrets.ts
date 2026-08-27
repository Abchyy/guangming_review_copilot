import type { RuntimeConfigStatus, RuntimeKeySource } from "@/lib/runtime-config";
import { getRuntimeSessionStore } from "@/lib/server/runtime-session-store";
import { readRuntimeSessionId } from "@/lib/server/runtime-session-cookie";

export type EnvLike = Record<string, string | undefined>;

export type RuntimeSessionKeyView = {
  deepseekApiKey?: string;
  tavilyApiKey?: string;
};

export type ResolvedRuntimeSecrets = {
  deepseekApiKey?: string;
  tavilyApiKey?: string;
  deepseekSource: RuntimeKeySource;
  tavilySource: RuntimeKeySource;
  realReviewEnabled: boolean;
  webEvidenceEnabled: boolean;
  reviewProvider: "fixture" | "deepseek" | "openai";
};

function trimKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readReviewProvider(env: EnvLike): "fixture" | "deepseek" | "openai" {
  const value = env.REVIEW_PROVIDER?.trim() || "fixture";
  if (value === "deepseek" || value === "openai" || value === "fixture") {
    return value;
  }
  return "fixture";
}

function sourceOf(sessionKey: string | undefined, envKey: string | undefined): RuntimeKeySource {
  if (sessionKey) {
    return "session";
  }
  if (envKey) {
    return "environment";
  }
  return "missing";
}

export function resolveRuntimeSecrets(
  session: RuntimeSessionKeyView | undefined,
  env: EnvLike = process.env,
): ResolvedRuntimeSecrets {
  const sessionDeepseek = trimKey(session?.deepseekApiKey);
  const sessionTavily = trimKey(session?.tavilyApiKey);
  const envDeepseek = trimKey(env.DEEPSEEK_API_KEY);
  const envTavily = trimKey(env.TAVILY_API_KEY);
  const reviewProvider = readReviewProvider(env);
  const deepseekSource = sourceOf(sessionDeepseek, envDeepseek);
  const tavilySource = sourceOf(sessionTavily, envTavily);
  const deepseekApiKey = sessionDeepseek ?? envDeepseek;
  const tavilyApiKey = sessionTavily ?? envTavily;
  const envOpenAi = trimKey(env.OPENAI_API_KEY);
  const realReviewEnabled = Boolean(
    sessionDeepseek ||
      (reviewProvider === "deepseek" && envDeepseek) ||
      (reviewProvider === "openai" && envOpenAi),
  );
  const webEvidenceEnabled = Boolean(
    sessionTavily || (tavilyApiKey && env.WEB_EVIDENCE_ENABLED?.trim() === "true"),
  );

  return {
    deepseekApiKey,
    tavilyApiKey,
    deepseekSource,
    tavilySource,
    realReviewEnabled,
    webEvidenceEnabled,
    reviewProvider,
  };
}

export function toRuntimeConfigStatus(resolved: ResolvedRuntimeSecrets): RuntimeConfigStatus {
  return {
    deepseek: {
      configured: resolved.deepseekSource !== "missing",
      source: resolved.deepseekSource,
    },
    tavily: {
      configured: resolved.tavilySource !== "missing",
      source: resolved.tavilySource,
    },
    capabilities: {
      real_review: resolved.realReviewEnabled,
      web_evidence: resolved.webEvidenceEnabled,
    },
  };
}

export function resolveRequestRuntimeSecrets(
  request: Request,
  env: EnvLike = process.env,
): ResolvedRuntimeSecrets {
  const sessionId = readRuntimeSessionId(request);
  const session = sessionId ? getRuntimeSessionStore().get(sessionId) : undefined;
  return resolveRuntimeSecrets(
    session
      ? { deepseekApiKey: session.deepseekApiKey, tavilyApiKey: session.tavilyApiKey }
      : undefined,
    env,
  );
}
