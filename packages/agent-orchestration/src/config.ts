import { SPECIALIST_MAX_PER_ARTICLE } from "@grc/contracts";

export {
  SPECIALIST_DISAGREEMENT_MESSAGE,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_PARTIAL_FAILURE_MESSAGE,
  SPECIALIST_TARGET_MODEL,
  SPECIALIST_TIMEOUT_MESSAGE,
} from "@grc/contracts";

export const FAKE_SPECIALIST_PROVIDER = "fixture" as const;
export const FAKE_SPECIALIST_MODEL = "fake-specialist";

export const DEFAULT_SPECIALIST_DEADLINE_MS = 2_000;
export const DEFAULT_MODEL_SPECIALIST_DEADLINE_MS = 15_000;
export const SPECIALIST_REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_SPECIALIST_MAX_CANDIDATES = 3;
export const SPECIALIST_MAX_TOKENS = 2048;
export const SPECIALIST_MAX_ATTEMPTS = 1;
export const SPECIALIST_SDK_MAX_RETRIES = 0;
export const FRAGMENT_CONTEXT_CHARS = 40;
export const SPECIALIST_DEADLINE_SKIP_REASON = "deadline";

export type EnvLike = Record<string, string | undefined>;

export function isSpecialistOrchestrationEnabled(env: EnvLike = process.env): boolean {
  return env.REVIEW_SPECIALISTS_ENABLED === "1";
}

export function specialistBudgetLimit(maxSpecialists = SPECIALIST_MAX_PER_ARTICLE): number {
  return Math.min(Math.max(1, maxSpecialists), SPECIALIST_MAX_PER_ARTICLE);
}
