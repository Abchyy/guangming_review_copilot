import { describe, expect, test } from "vitest";

import { FixtureReviewModel } from "@grc/providers";
import { estimateDeepSeekCost } from "@grc/providers";
import {
  OFFICIAL_BENCHMARK_MODEL,
  aggregateAttemptUsage,
  assertOfficialBenchmarkProvenance,
  buildHttpProvenance,
  extractObservedUsage,
} from "@grc/providers";
import { aggregateCallSnapshots, snapshotFromProvenance as snapshotRuntime } from "@grc/benchmark";
import { createReview } from "@grc/review-core";
import type { ObservedUsage, ProviderAttempt } from "@grc/contracts";

const reportedUsage = (overrides: Partial<ObservedUsage> = {}): ObservedUsage => ({
  input_tokens: 10,
  output_tokens: 4,
  cached_input_tokens: 2,
  cached_input_tokens_status: "reported",
  ...overrides,
});

function makeAttempt(attempt: number, overrides: Partial<ProviderAttempt> = {}): ProviderAttempt {
  return {
    attempt,
    outcome: "success",
    requested_model: OFFICIAL_BENCHMARK_MODEL,
    observed_response_model: OFFICIAL_BENCHMARK_MODEL,
    received_provider_response: true,
    usage: reportedUsage(),
    error: null,
    ...overrides,
  };
}

describe("provider usage extraction", () => {
  test("keeps provider-reported cache tokens", () => {
    expect(
      extractObservedUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 40,
      cached_input_tokens_status: "reported",
    });
  });

  test("does not treat missing cache tokens as a determined miss-priced cost", () => {
    const usage = extractObservedUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
    });
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: null,
      cached_input_tokens_status: "not_reported",
    });
    const cost = estimateDeepSeekCost({
      input_tokens: usage!.input_tokens,
      output_tokens: usage!.output_tokens,
      cached_input_tokens: usage!.cached_input_tokens,
    });
    expect(cost.cache_pricing).toBe("not_reported");
    expect(cost.cost_status).toBe("indeterminate");
    expect(cost.cost_usd).toBeNull();
  });

  test("treats reported zero cached tokens as determined cache pricing", () => {
    const cost = estimateDeepSeekCost({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0,
    });
    expect(cost.cache_pricing).toBe("reported");
    expect(cost.cost_status).toBe("determined");
    expect(cost.cost_usd).not.toBeNull();
  });
});

describe("retry usage aggregation", () => {
  test("sums observed usage across retry attempts when every attempt is complete", () => {
    const aggregated = aggregateAttemptUsage([
      makeAttempt(1, {
        outcome: "retryable_failure",
        usage: reportedUsage({ input_tokens: 10, output_tokens: 4, cached_input_tokens: 2 }),
        error: "Provider response was not valid JSON",
      }),
      makeAttempt(2, {
        usage: reportedUsage({ input_tokens: 20, output_tokens: 8, cached_input_tokens: 3 }),
      }),
    ]);
    expect(aggregated).toEqual({
      input_tokens: 30,
      input_tokens_completeness: "complete",
      output_tokens: 12,
      output_tokens_completeness: "complete",
      cached_input_tokens: 5,
      cached_input_tokens_status: "reported",
      cached_input_tokens_completeness: "complete",
      unobserved_usage_attempts: 0,
    });
  });

  test("does not report a complete total when an entire attempt usage is missing", () => {
    const aggregated = aggregateAttemptUsage([
      makeAttempt(1, {
        outcome: "retryable_failure",
        observed_response_model: null,
        received_provider_response: false,
        usage: null,
        error: "network",
      }),
      makeAttempt(2, {
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          cached_input_tokens: null,
          cached_input_tokens_status: "not_reported",
        },
      }),
    ]);
    expect(aggregated.input_tokens).toBeNull();
    expect(aggregated.input_tokens_completeness).toBe("incomplete");
    expect(aggregated.output_tokens).toBeNull();
    expect(aggregated.output_tokens_completeness).toBe("incomplete");
    expect(aggregated.cached_input_tokens).toBeNull();
    expect(aggregated.cached_input_tokens_status).toBe("not_reported");
    expect(aggregated.cached_input_tokens_completeness).toBe("incomplete");
    expect(aggregated.unobserved_usage_attempts).toBe(1);
  });

  test("does not report a complete total when one attempt is missing a usage field", () => {
    const aggregated = aggregateAttemptUsage([
      makeAttempt(1, {
        outcome: "retryable_failure",
        usage: reportedUsage({ input_tokens: null, output_tokens: 4, cached_input_tokens: 1 }),
        error: "partial usage",
      }),
      makeAttempt(2, {
        usage: reportedUsage({ input_tokens: 20, output_tokens: 8, cached_input_tokens: 3 }),
      }),
    ]);
    expect(aggregated.input_tokens).toBeNull();
    expect(aggregated.input_tokens_completeness).toBe("incomplete");
    expect(aggregated.output_tokens).toBe(12);
    expect(aggregated.output_tokens_completeness).toBe("complete");
    expect(aggregated.cached_input_tokens).toBe(4);
    expect(aggregated.cached_input_tokens_completeness).toBe("complete");
  });

  test("marks fully missing retry usage as incomplete rather than zero", () => {
    const aggregated = aggregateAttemptUsage([
      makeAttempt(1, { outcome: "retryable_failure", usage: null, error: "network" }),
      makeAttempt(2, { outcome: "retryable_failure", usage: null, error: "network" }),
    ]);
    expect(aggregated.input_tokens).toBeNull();
    expect(aggregated.output_tokens).toBeNull();
    expect(aggregated.cached_input_tokens).toBeNull();
    expect(aggregated.input_tokens_completeness).toBe("incomplete");
    expect(aggregated.output_tokens_completeness).toBe("incomplete");
    expect(aggregated.cached_input_tokens_completeness).toBe("incomplete");
    expect(aggregated.unobserved_usage_attempts).toBe(2);
  });
});

describe("official benchmark provenance", () => {
  test("fails closed when the observed response model differs from expected", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [makeAttempt(1, { observed_response_model: "deepseek-other" })],
      latencyMs: 10,
    });
    expect(() => assertOfficialBenchmarkProvenance(provenance)).toThrow(
      /observed response model deepseek-other/,
    );
  });

  test("fails closed when the provider does not report a response model", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [makeAttempt(1, { observed_response_model: null })],
      latencyMs: 10,
    });
    expect(() => assertOfficialBenchmarkProvenance(provenance)).toThrow(
      /response model was not reported/,
    );
  });

  test("fails closed when an earlier received response is missing a model even if a later retry matches", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, {
          outcome: "retryable_failure",
          observed_response_model: null,
          error: "empty",
        }),
        makeAttempt(2),
      ],
      latencyMs: 10,
    });
    expect(provenance.observed_response_model).toBeNull();
    expect(provenance.observed_response_model_status).toBe("not_reported");
    expect(() => assertOfficialBenchmarkProvenance(provenance)).toThrow(
      /response model was not reported on attempt 1/,
    );
  });

  test("fails closed when an earlier received response mismatches even if a later retry matches", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, {
          outcome: "retryable_failure",
          observed_response_model: "deepseek-other",
          error: "schema",
        }),
        makeAttempt(2),
      ],
      latencyMs: 10,
    });
    expect(provenance.observed_response_model).toBeNull();
    expect(provenance.observed_response_model_status).toBe("inconsistent");
    expect(() => assertOfficialBenchmarkProvenance(provenance)).toThrow(
      /observed response model deepseek-other !== .* on attempt 1/,
    );
  });

  test("accepts a matching later response when the earlier attempt never received a provider response", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, {
          outcome: "retryable_failure",
          observed_response_model: null,
          received_provider_response: false,
          usage: null,
          error: "network",
        }),
        makeAttempt(2),
      ],
      latencyMs: 10,
    });
    expect(provenance.observed_response_model).toBe(OFFICIAL_BENCHMARK_MODEL);
    expect(provenance.observed_response_model_status).toBe("observed");
    expect(() => assertOfficialBenchmarkProvenance(provenance)).not.toThrow();
  });

  test("accepts a run where every received provider response matches the expected model", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, { outcome: "retryable_failure", error: "json" }),
        makeAttempt(2),
      ],
      latencyMs: 10,
    });
    expect(() => assertOfficialBenchmarkProvenance(provenance)).not.toThrow();
  });
});

describe("runtime report provenance", () => {
  test("does not hardcode provider or cache facts, and does not invent a determined cost when cache tokens are unreported", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, {
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cached_input_tokens: null,
            cached_input_tokens_status: "not_reported",
          },
        }),
      ],
      latencyMs: 15,
      applicationCache: { enabled: false, hit: false },
    });
    const snapshot = snapshotRuntime(provenance);
    expect(snapshot.adapter_provider).toBe(provenance.adapter_provider);
    expect(snapshot.requested_model).toBe(provenance.requested_model);
    expect(snapshot.observed_response_model).toBe(OFFICIAL_BENCHMARK_MODEL);
    expect(snapshot.aggregated_usage.cached_input_tokens).toBeNull();
    expect(snapshot.aggregated_usage.cached_input_tokens_status).toBe("not_reported");
    expect(snapshot.cost_cache_pricing).toBe("not_reported");
    expect(snapshot.cost_status).toBe("indeterminate");
    expect(snapshot.cost_usd).toBeNull();
    expect(snapshot.application_cache).toEqual({ enabled: false, hit: false });
    const aggregated = aggregateCallSnapshots([snapshot, snapshot]);
    expect(aggregated.logical_calls).toBe(2);
    expect(aggregated.provider_attempt_count).toBe(2);
    expect(aggregated.aggregated_usage.cached_input_tokens).toBeNull();
    expect(aggregated.cost_usd).toBeNull();
    expect(aggregated.cost_status).toBe("indeterminate");
    expect(JSON.stringify(aggregated)).not.toMatch(/"api_calls"/);
    expect(JSON.stringify(aggregated)).not.toMatch(/"cache_disabled"/);
  });

  test("does not treat incomplete retry usage as a determined cost", () => {
    const provenance = buildHttpProvenance({
      adapterProvider: "deepseek",
      requestedModel: OFFICIAL_BENCHMARK_MODEL,
      attempts: [
        makeAttempt(1, {
          outcome: "retryable_failure",
          received_provider_response: false,
          usage: null,
          error: "network",
        }),
        makeAttempt(2, { usage: reportedUsage({ input_tokens: 20, output_tokens: 8, cached_input_tokens: 3 }) }),
      ],
      latencyMs: 12,
    });
    const snapshot = snapshotRuntime(provenance);
    expect(snapshot.aggregated_usage.input_tokens).toBeNull();
    expect(snapshot.aggregated_usage.input_tokens_completeness).toBe("incomplete");
    expect(snapshot.cost_usd).toBeNull();
    expect(snapshot.cost_status).toBe("indeterminate");
  });

  test("does not apply DeepSeek pricing to OpenAI or fixture adapters", () => {
    const openai = snapshotRuntime(
      buildHttpProvenance({
        adapterProvider: "openai",
        requestedModel: "gpt-5.4",
        attempts: [
          makeAttempt(1, {
            requested_model: "gpt-5.4",
            observed_response_model: "gpt-5.4",
            usage: reportedUsage({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 }),
          }),
        ],
        latencyMs: 9,
      }),
    );
    expect(openai.cost_usd).toBeNull();
    expect(openai.cost_status).toBe("not_applicable");
    expect(openai.cost_cache_pricing).toBe("not_applicable");

    const fixture = snapshotRuntime(
      buildHttpProvenance({
        adapterProvider: "fixture",
        requestedModel: null,
        attempts: [],
        latencyMs: 0,
      }),
    );
    expect(fixture.cost_usd).toBeNull();
    expect(fixture.cost_status).toBe("not_applicable");
    expect(fixture.cost_cache_pricing).toBe("not_applicable");
  });
});

describe("fixture execution provenance", () => {
  test("records adapter identity without pretending a provider model was observed", async () => {
    const result = await createReview(
      { title: "标题", body: "正文" },
      new FixtureReviewModel([]),
    );
    const provenance = result.pipeline.provenance;
    expect(provenance?.adapter_provider).toBe("fixture");
    expect(provenance?.requested_model).toBeNull();
    expect(provenance?.observed_response_model_status).toBe("not_reported");
    expect(provenance?.attempt_count).toBe(0);
    expect(provenance?.application_cache).toEqual({ enabled: false, hit: false });
    expect(result.pipeline.provider).toBe("fixture");
    expect(result.pipeline.model).toBeNull();
    const snapshot = snapshotRuntime(provenance!);
    expect(snapshot.cost_usd).toBeNull();
    expect(snapshot.cost_status).toBe("not_applicable");
    expect(snapshot.cost_cache_pricing).toBe("not_applicable");
  });
});
