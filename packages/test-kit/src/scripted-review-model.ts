import type { ProviderAttempt, ReviewCandidate, ReviewExecutionProvenance, ReviewProvider } from "@grc/contracts";
import { OFFICIAL_BENCHMARK_MODEL, buildHttpProvenance } from "@grc/providers";
import type { ReviewModel } from "@grc/providers";

export class ScriptedReviewModel implements ReviewModel {
  readonly provider: ReviewProvider;
  readonly model: string | null;
  private lastProvenance: ReviewExecutionProvenance | null = null;

  constructor(
    private readonly options: {
      provider: ReviewProvider;
      model: string | null;
      candidates?: ReviewCandidate[];
      provenance: ReviewExecutionProvenance;
    },
  ) {
    this.provider = options.provider;
    this.model = options.model;
  }

  review(): Promise<ReviewCandidate[]> {
    this.lastProvenance = structuredClone(this.options.provenance);
    return Promise.resolve((this.options.candidates ?? []).map((item) => structuredClone(item)));
  }

  consumeLastProvenance(): ReviewExecutionProvenance | null {
    const provenance = this.lastProvenance;
    this.lastProvenance = null;
    return provenance;
  }
}

export function officialAttempt(overrides: Partial<ProviderAttempt> = {}): ProviderAttempt {
  return {
    attempt: 1,
    outcome: "success",
    requested_model: OFFICIAL_BENCHMARK_MODEL,
    observed_response_model: OFFICIAL_BENCHMARK_MODEL,
    received_provider_response: true,
    usage: {
      input_tokens: 12,
      output_tokens: 6,
      cached_input_tokens: 0,
      cached_input_tokens_status: "reported",
    },
    error: null,
    ...overrides,
  };
}

export function officialSuccessProvenance(
  attempts: ProviderAttempt[] = [officialAttempt()],
): ReviewExecutionProvenance {
  return buildHttpProvenance({
    adapterProvider: "deepseek",
    requestedModel: OFFICIAL_BENCHMARK_MODEL,
    attempts,
    latencyMs: 8,
  });
}
