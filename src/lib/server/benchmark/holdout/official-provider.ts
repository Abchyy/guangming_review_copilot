import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { assertOfficialRuntime, type SystemFreezeManifest } from "@/lib/server/benchmark/holdout/freeze";
import { DeepSeekReviewModel } from "@/lib/server/llm/deepseek-review-model";
import { OFFICIAL_BENCHMARK_MODEL, OFFICIAL_BENCHMARK_PROVIDER } from "@/lib/server/llm/provenance";

export function rejectCallerOfficialProviderInjection(options: object): void {
  const record = options as Record<string, unknown>;
  if (record.model != null) {
    throw new HoldoutProtocolError("Official inference cannot use a caller-supplied ReviewModel");
  }
  if (record.client != null || record.apiKey != null || record.baseURL != null) {
    throw new HoldoutProtocolError(
      "Official inference cannot use a caller-supplied provider client or credential",
    );
  }
}

export function createOfficialFrozenDeepSeekModel(freeze: SystemFreezeManifest): DeepSeekReviewModel {
  assertOfficialRuntime(freeze.runtime);
  const model = DeepSeekReviewModel.createCanonicalOfficial();
  const execution = model.officialExecution;
  if (!execution) {
    throw new HoldoutProtocolError("Official inference did not bind a canonical DeepSeek execution");
  }
  if (model.provider !== OFFICIAL_BENCHMARK_PROVIDER || execution.provider !== freeze.runtime.adapter_provider) {
    throw new HoldoutProtocolError("Canonical DeepSeek execution provider does not match the frozen runtime");
  }
  if (model.model !== freeze.runtime.requested_model || execution.requested_model !== freeze.runtime.requested_model) {
    throw new HoldoutProtocolError(
      `Canonical DeepSeek execution model ${model.model} does not match freeze ${freeze.runtime.requested_model}`,
    );
  }
  if (execution.requested_model !== OFFICIAL_BENCHMARK_MODEL) {
    throw new HoldoutProtocolError("Canonical DeepSeek execution is not the official benchmark model");
  }
  if (execution.provider_endpoint !== freeze.runtime.provider_endpoint) {
    throw new HoldoutProtocolError(
      `Canonical DeepSeek endpoint ${execution.provider_endpoint} does not match freeze ${freeze.runtime.provider_endpoint}`,
    );
  }
  if (execution.account_boundary_id !== freeze.runtime.account_boundary_id) {
    throw new HoldoutProtocolError(
      "Canonical DeepSeek account boundary identity does not match the frozen credential",
    );
  }
  return model;
}
