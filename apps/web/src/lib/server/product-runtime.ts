import {
  createSpecialistRuntimeFromEnv,
  SPECIALIST_REQUEST_TIMEOUT_MS,
  SPECIALIST_TARGET_MODEL,
} from "@grc/agent-orchestration";
import type { SpecialistRuntime, WebEvidenceCollector } from "@grc/contracts";
import {
  DeepSeekReviewModel,
  FixtureReviewModel,
  getDeepSeekApiKey,
  OpenAIReviewModel,
} from "@grc/providers";
import type { ReviewModel } from "@grc/providers";
import { createWebEvidenceCollector, TavilySearchProvider } from "@grc/web-evidence";

import {
  resolveRequestRuntimeSecrets,
  toRuntimeConfigStatus,
  type ResolvedRuntimeSecrets,
} from "@/lib/server/runtime-secrets";
import { resetRuntimeSessionStore } from "@/lib/server/runtime-session-store";

export type ProductRuntime = {
  model: ReviewModel;
  webEvidenceCollector: WebEvidenceCollector | null;
  specialistRuntime: SpecialistRuntime | null;
  capabilities: {
    real_review: boolean;
    web_evidence: boolean;
  };
};

export type ProductRuntimeFactory = (resolved: ResolvedRuntimeSecrets) => ProductRuntime;

export function createProductSpecialistRuntime(
  apiKey = getDeepSeekApiKey(),
): SpecialistRuntime | null {
  if (!apiKey) {
    return null;
  }
  return createSpecialistRuntimeFromEnv(process.env, {
    clientFactory: () =>
      new DeepSeekReviewModel({
        apiKey,
        model: SPECIALIST_TARGET_MODEL,
        timeoutMs: SPECIALIST_REQUEST_TIMEOUT_MS,
      }),
  });
}

let runtimeFactory: ProductRuntimeFactory | undefined;

export function setProductRuntimeFactoryForTests(factory?: ProductRuntimeFactory): void {
  runtimeFactory = factory;
}

export function resetProductRuntimeForTests(): void {
  runtimeFactory = undefined;
  resetRuntimeSessionStore();
}

export function createProductRuntime(resolved: ResolvedRuntimeSecrets): ProductRuntime {
  const sessionDeepseek = resolved.deepseekSource === "session" ? resolved.deepseekApiKey : undefined;
  let model: ReviewModel;
  if (sessionDeepseek) {
    model = new DeepSeekReviewModel({ apiKey: sessionDeepseek });
  } else if (resolved.reviewProvider === "deepseek" && resolved.deepseekApiKey) {
    model = new DeepSeekReviewModel({ apiKey: resolved.deepseekApiKey });
  } else if (resolved.reviewProvider === "openai") {
    model = new OpenAIReviewModel();
  } else {
    model = new FixtureReviewModel();
  }

  const tavilyApiKey =
    resolved.webEvidenceEnabled && resolved.tavilyApiKey ? resolved.tavilyApiKey : undefined;
  const webEvidenceCollector = tavilyApiKey
    ? createWebEvidenceCollector(new TavilySearchProvider({ apiKey: tavilyApiKey }))
    : null;

  const specialistKey =
    resolved.deepseekSource === "session" || resolved.deepseekSource === "environment"
      ? resolved.deepseekApiKey
      : undefined;

  return {
    model,
    webEvidenceCollector,
    specialistRuntime: createProductSpecialistRuntime(specialistKey),
    capabilities: toRuntimeConfigStatus(resolved).capabilities,
  };
}

export function getProductRuntime(request: Request): ProductRuntime {
  const resolved = resolveRequestRuntimeSecrets(request);
  return (runtimeFactory ?? createProductRuntime)(resolved);
}
