import type {
  AggregatedUsage,
  AttemptOutcome,
  CachedTokenStatus,
  ObservationCompleteness,
  ObservedUsage,
  ProviderAttempt,
  ReviewExecutionProvenance,
  ReviewProvider,
} from "@grc/contracts";
import { DEFAULT_PRODUCTION_MODEL } from "./config";
import type { ProviderCallUsage } from "./review-model";

export const OFFICIAL_BENCHMARK_PROVIDER = "deepseek" as const;
export const OFFICIAL_BENCHMARK_MODEL = DEFAULT_PRODUCTION_MODEL;

export type RawProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
} | null | undefined;

export type ApplicationCacheState = {
  enabled: boolean;
  hit: boolean;
};

export function observedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function cachedTokensFromDetails(details: unknown): {
  value: number | null;
  status: "reported" | "not_reported";
} {
  if (!details || typeof details !== "object") {
    return { value: null, status: "not_reported" };
  }
  if (!("cached_tokens" in details)) {
    return { value: null, status: "not_reported" };
  }
  const value = finiteNumber((details as { cached_tokens?: unknown }).cached_tokens);
  if (value == null) {
    return { value: null, status: "not_reported" };
  }
  return { value, status: "reported" };
}

export function extractObservedUsage(raw: RawProviderUsage): ObservedUsage | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const cached = cachedTokensFromDetails(raw.prompt_tokens_details ?? raw.input_tokens_details);
  return {
    input_tokens: finiteNumber(raw.prompt_tokens ?? raw.input_tokens),
    output_tokens: finiteNumber(raw.completion_tokens ?? raw.output_tokens),
    cached_input_tokens: cached.value,
    cached_input_tokens_status: cached.status,
  };
}

function completeSum(values: Array<number | null>): { value: number | null; completeness: ObservationCompleteness } {
  if (values.length === 0) {
    return { value: null, completeness: "not_observed" };
  }
  if (values.some((item) => item == null)) {
    return { value: null, completeness: "incomplete" };
  }
  return {
    value: values.reduce<number>((sum, item) => sum + (item ?? 0), 0),
    completeness: "complete",
  };
}

export function aggregateAttemptUsage(attempts: ProviderAttempt[]): AggregatedUsage {
  const unobserved = attempts.filter((item) => item.usage == null).length;
  const input = completeSum(attempts.map((item) => item.usage?.input_tokens ?? null));
  const output = completeSum(attempts.map((item) => item.usage?.output_tokens ?? null));
  const cacheValues = attempts.map((item) =>
    item.usage?.cached_input_tokens_status === "reported" ? item.usage.cached_input_tokens : null,
  );
  const cache = completeSum(cacheValues);
  const cacheStatuses = new Set(
    attempts.map((item) => item.usage?.cached_input_tokens_status ?? "not_reported"),
  );
  let cachedStatus: CachedTokenStatus = "not_reported";
  if (cache.completeness === "complete") {
    cachedStatus = "reported";
  } else if (cacheStatuses.has("reported") && cacheStatuses.has("not_reported")) {
    cachedStatus = "mixed";
  }
  return {
    input_tokens: input.value,
    input_tokens_completeness: input.completeness,
    output_tokens: output.value,
    output_tokens_completeness: output.completeness,
    cached_input_tokens: cache.completeness === "complete" ? cache.value : null,
    cached_input_tokens_status: cachedStatus,
    cached_input_tokens_completeness: cache.completeness,
    unobserved_usage_attempts: unobserved,
  };
}

export function summarizeObservedResponseModel(attempts: ProviderAttempt[]): {
  model: string | null;
  status: ReviewExecutionProvenance["observed_response_model_status"];
} {
  const received = attempts.filter((item) => item.received_provider_response);
  if (received.length === 0) {
    return { model: null, status: "not_reported" };
  }
  if (received.some((item) => item.observed_response_model == null)) {
    return { model: null, status: "not_reported" };
  }
  const models = new Set(received.map((item) => item.observed_response_model as string));
  if (models.size === 1) {
    return { model: [...models][0]!, status: "observed" };
  }
  return { model: null, status: "inconsistent" };
}

export function buildHttpProvenance(input: {
  adapterProvider: ReviewProvider;
  requestedModel: string | null;
  attempts: ProviderAttempt[];
  latencyMs: number;
  applicationCache?: ApplicationCacheState;
}): ReviewExecutionProvenance {
  const observed = summarizeObservedResponseModel(input.attempts);
  return {
    adapter_provider: input.adapterProvider,
    requested_model: input.requestedModel,
    observed_response_model: observed.model,
    observed_response_model_status: observed.status,
    attempt_count: input.attempts.length,
    attempts: input.attempts,
    aggregated_usage: aggregateAttemptUsage(input.attempts),
    application_cache: input.applicationCache ?? { enabled: false, hit: false },
    latency_ms: input.latencyMs,
  };
}

export function applicationCacheProvenance(input: {
  adapterProvider: ReviewProvider;
  requestedModel: string | null;
  enabled: boolean;
  hit: boolean;
}): ReviewExecutionProvenance {
  return {
    adapter_provider: input.adapterProvider,
    requested_model: input.requestedModel,
    observed_response_model: null,
    observed_response_model_status: "not_reported",
    attempt_count: 0,
    attempts: [],
    aggregated_usage: aggregateAttemptUsage([]),
    application_cache: { enabled: input.enabled, hit: input.hit },
    latency_ms: 0,
  };
}

export function attachApplicationCache(
  provenance: ReviewExecutionProvenance,
  cache: ApplicationCacheState,
): ReviewExecutionProvenance {
  return {
    ...provenance,
    application_cache: cache,
  };
}

export function fallbackProvenance(input: {
  adapterProvider: ReviewProvider;
  requestedModel: string | null;
  applicationCache: ApplicationCacheState;
}): ReviewExecutionProvenance {
  if (input.applicationCache.hit) {
    return applicationCacheProvenance({
      adapterProvider: input.adapterProvider,
      requestedModel: input.requestedModel,
      enabled: input.applicationCache.enabled,
      hit: true,
    });
  }
  return buildHttpProvenance({
    adapterProvider: input.adapterProvider,
    requestedModel: input.requestedModel,
    attempts: [
      {
        attempt: 1,
        outcome: "success",
        requested_model: input.requestedModel,
        observed_response_model: null,
        received_provider_response: false,
        usage: null,
        error: null,
      },
    ],
    latencyMs: 0,
    applicationCache: input.applicationCache,
  });
}

export function projectUsage(
  provenance: ReviewExecutionProvenance,
): ProviderCallUsage {
  return {
    input_tokens: provenance.aggregated_usage.input_tokens,
    output_tokens: provenance.aggregated_usage.output_tokens,
    cached_input_tokens: provenance.aggregated_usage.cached_input_tokens,
    latency_ms: provenance.latency_ms,
  };
}

export function attemptRecord(input: {
  attempt: number;
  outcome: AttemptOutcome;
  requestedModel: string | null;
  observedResponseModel: string | null;
  receivedProviderResponse: boolean;
  usage: ObservedUsage | null;
  error: unknown;
}): ProviderAttempt {
  return {
    attempt: input.attempt,
    outcome: input.outcome,
    requested_model: input.requestedModel,
    observed_response_model: input.observedResponseModel,
    received_provider_response: input.receivedProviderResponse,
    usage: input.usage,
    error: errorMessage(input.error),
  };
}

function errorMessage(error: unknown): string | null {
  if (error == null) {
    return null;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const text = String(error);
  return text.length > 0 ? text : null;
}

export function assertOfficialBenchmarkProvenance(
  provenance: ReviewExecutionProvenance,
  expected: { provider: ReviewProvider; model: string } = {
    provider: OFFICIAL_BENCHMARK_PROVIDER,
    model: OFFICIAL_BENCHMARK_MODEL,
  },
): void {
  if (provenance.adapter_provider !== expected.provider) {
    throw new Error(
      `Refusing official benchmark result: adapter provider ${provenance.adapter_provider} !== ${expected.provider}`,
    );
  }
  if (provenance.requested_model !== expected.model) {
    throw new Error(
      `Refusing official benchmark result: requested model ${provenance.requested_model} !== ${expected.model}`,
    );
  }
  const received = provenance.attempts.filter((item) => item.received_provider_response);
  if (received.length === 0) {
    throw new Error(
      "Refusing official benchmark result: no provider response was available to verify the model",
    );
  }
  if (!provenance.attempts.some((item) => item.outcome === "success")) {
    throw new Error(
      "Refusing official benchmark result: no provider attempt completed successfully",
    );
  }
  for (const attempt of received) {
    if (attempt.observed_response_model == null) {
      throw new Error(
        `Refusing official benchmark result: provider response model was not reported on attempt ${attempt.attempt}`,
      );
    }
    if (attempt.observed_response_model !== expected.model) {
      throw new Error(
        `Refusing official benchmark result: observed response model ${attempt.observed_response_model} !== ${expected.model} on attempt ${attempt.attempt}`,
      );
    }
  }
}

export function assertObservedModelMatchesExpected(
  provenance: ReviewExecutionProvenance,
  expectedModel: string,
): void {
  const mismatched = provenance.attempts.find(
    (item) =>
      item.received_provider_response &&
      item.observed_response_model != null &&
      item.observed_response_model !== expectedModel,
  );
  if (mismatched) {
    throw new Error(
      `Observed response model ${mismatched.observed_response_model} does not match expected ${expectedModel}`,
    );
  }
}
