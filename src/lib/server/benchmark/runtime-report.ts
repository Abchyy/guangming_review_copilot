import type { ReviewExecutionProvenance } from "@/lib/contracts/review";
import { estimateDeepSeekCost, type DeepSeekCostEstimate } from "@/lib/server/llm/deepseek-pricing";

export type CallRuntimeSnapshot = {
  adapter_provider: ReviewExecutionProvenance["adapter_provider"];
  requested_model: string | null;
  observed_response_model: string | null;
  observed_response_model_status: ReviewExecutionProvenance["observed_response_model_status"];
  attempt_count: number;
  aggregated_usage: ReviewExecutionProvenance["aggregated_usage"];
  application_cache: ReviewExecutionProvenance["application_cache"];
  cost_usd: number | null;
  cost_status: DeepSeekCostEstimate["cost_status"];
  cost_cache_pricing: DeepSeekCostEstimate["cache_pricing"];
  latency_ms: number;
};

export function costFromProvenance(provenance: ReviewExecutionProvenance): DeepSeekCostEstimate {
  if (provenance.adapter_provider !== "deepseek") {
    return {
      cost_usd: null,
      cost_status: "not_applicable",
      cache_pricing: "not_applicable",
    };
  }
  const usage = provenance.aggregated_usage;
  if (
    usage.input_tokens_completeness !== "complete" ||
    usage.output_tokens_completeness !== "complete" ||
    usage.cached_input_tokens_completeness !== "complete"
  ) {
    if (usage.input_tokens_completeness === "not_observed" && usage.output_tokens_completeness === "not_observed") {
      return {
        cost_usd: null,
        cost_status: "not_applicable",
        cache_pricing: "not_applicable",
      };
    }
    return {
      cost_usd: null,
      cost_status: "indeterminate",
      cache_pricing:
        usage.cached_input_tokens_completeness === "complete" ? "reported" : "not_reported",
    };
  }
  return estimateDeepSeekCost({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_input_tokens: usage.cached_input_tokens,
  });
}

export function snapshotFromProvenance(
  provenance: ReviewExecutionProvenance,
  cost: DeepSeekCostEstimate | null = costFromProvenance(provenance),
): CallRuntimeSnapshot {
  const resolved = cost ?? costFromProvenance(provenance);
  return {
    adapter_provider: provenance.adapter_provider,
    requested_model: provenance.requested_model,
    observed_response_model: provenance.observed_response_model,
    observed_response_model_status: provenance.observed_response_model_status,
    attempt_count: provenance.attempt_count,
    aggregated_usage: provenance.aggregated_usage,
    application_cache: provenance.application_cache,
    cost_usd: resolved.cost_usd,
    cost_status: resolved.cost_status,
    cost_cache_pricing: resolved.cache_pricing,
    latency_ms: provenance.latency_ms,
  };
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((item): item is string => item != null && item.length > 0))];
}

function mergeCompleteness(
  values: Array<ReviewExecutionProvenance["aggregated_usage"]["input_tokens_completeness"]>,
): ReviewExecutionProvenance["aggregated_usage"]["input_tokens_completeness"] {
  if (values.length === 0) {
    return "not_observed";
  }
  if (values.every((item) => item === "complete")) {
    return "complete";
  }
  if (values.every((item) => item === "not_observed")) {
    return "not_observed";
  }
  return "incomplete";
}

export function aggregateCallSnapshots(snapshots: CallRuntimeSnapshot[]): {
  logical_calls: number;
  provider_attempt_count: number;
  adapter_providers: string[];
  requested_models: string[];
  observed_response_models: string[];
  observed_response_model_status:
    | ReviewExecutionProvenance["observed_response_model_status"]
    | "mixed";
  aggregated_usage: ReviewExecutionProvenance["aggregated_usage"];
  application_cache: { enabled: boolean; hit: boolean };
  cost_usd: number | null;
  cost_status: DeepSeekCostEstimate["cost_status"] | "mixed";
  cost_cache_pricing: DeepSeekCostEstimate["cache_pricing"] | "mixed";
} {
  const usage = snapshots.map((item) => item.aggregated_usage);
  const cacheStatuses = new Set(usage.map((item) => item.cached_input_tokens_status));
  const modelStatuses = new Set(snapshots.map((item) => item.observed_response_model_status));
  const costStatuses = new Set(snapshots.map((item) => item.cost_status));
  const cachePricing = new Set(snapshots.map((item) => item.cost_cache_pricing));
  const inputCompleteness = mergeCompleteness(usage.map((item) => item.input_tokens_completeness));
  const outputCompleteness = mergeCompleteness(usage.map((item) => item.output_tokens_completeness));
  const cacheCompleteness = mergeCompleteness(usage.map((item) => item.cached_input_tokens_completeness));
  const determinedCosts =
    snapshots.length > 0 &&
    snapshots.every((item) => item.cost_status === "determined" && item.cost_usd != null);
  return {
    logical_calls: snapshots.length,
    provider_attempt_count: snapshots.reduce((sum, item) => sum + item.attempt_count, 0),
    adapter_providers: unique(snapshots.map((item) => item.adapter_provider)),
    requested_models: unique(snapshots.map((item) => item.requested_model)),
    observed_response_models: unique(snapshots.map((item) => item.observed_response_model)),
    observed_response_model_status: modelStatuses.size === 1 ? [...modelStatuses][0]! : "mixed",
    aggregated_usage: {
      input_tokens:
        inputCompleteness === "complete"
          ? usage.reduce((sum, item) => sum + (item.input_tokens ?? 0), 0)
          : null,
      input_tokens_completeness: inputCompleteness,
      output_tokens:
        outputCompleteness === "complete"
          ? usage.reduce((sum, item) => sum + (item.output_tokens ?? 0), 0)
          : null,
      output_tokens_completeness: outputCompleteness,
      cached_input_tokens:
        cacheCompleteness === "complete"
          ? usage.reduce((sum, item) => sum + (item.cached_input_tokens ?? 0), 0)
          : null,
      cached_input_tokens_status:
        cacheStatuses.size === 1 ? [...cacheStatuses][0]! : cacheStatuses.size === 0 ? "not_reported" : "mixed",
      cached_input_tokens_completeness: cacheCompleteness,
      unobserved_usage_attempts: usage.reduce((sum, item) => sum + item.unobserved_usage_attempts, 0),
    },
    application_cache: {
      enabled: snapshots.some((item) => item.application_cache.enabled),
      hit: snapshots.some((item) => item.application_cache.hit),
    },
    cost_usd: determinedCosts
      ? snapshots.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0)
      : null,
    cost_status: costStatuses.size === 1 ? [...costStatuses][0]! : "mixed",
    cost_cache_pricing: cachePricing.size === 1 ? [...cachePricing][0]! : "mixed",
  };
}
