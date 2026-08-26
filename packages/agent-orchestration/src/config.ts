import { SPECIALIST_MAX_PER_ARTICLE } from "@grc/contracts";

export const SPECIALIST_TARGET_MODEL = "deepseek-v4-flash";
export const FAKE_SPECIALIST_PROVIDER = "fixture" as const;
export const FAKE_SPECIALIST_MODEL = "fake-specialist";

export const DEFAULT_SPECIALIST_DEADLINE_MS = 2_000;
export const DEFAULT_SPECIALIST_MAX_CANDIDATES = 8;
export const FRAGMENT_CONTEXT_CHARS = 40;

export const SPECIALIST_DISAGREEMENT_MESSAGE = "专家结论存在分歧，待人工核实";
export const SPECIALIST_PARTIAL_FAILURE_MESSAGE = "专项核验部分失败，待人工核实";
export const SPECIALIST_TIMEOUT_MESSAGE = "专项核验超时，待人工核实";
export const SPECIALIST_FAILURE_MESSAGE = "专项核验失败，待人工核实";

export type EnvLike = Record<string, string | undefined>;

export function isSpecialistOrchestrationEnabled(env: EnvLike = process.env): boolean {
  return env.REVIEW_SPECIALISTS_ENABLED === "1";
}

export function specialistBudgetLimit(maxSpecialists = SPECIALIST_MAX_PER_ARTICLE): number {
  return Math.min(Math.max(1, maxSpecialists), SPECIALIST_MAX_PER_ARTICLE);
}
