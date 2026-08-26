export const OFFLINE_MODEL_ENV_KEYS = [
  "REVIEW_PROVIDER",
  "REVIEW_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "TAVILY_API_KEY",
  "WEB_EVIDENCE_ENABLED",
  "REVIEW_SPECIALISTS_ENABLED",
  "BENCHMARK_DEV_LIVE",
  "BENCHMARK_LOCKED",
  "LIVE_SMOKE",
] as const;

export function applyOfflineTestEnv(): void {
  for (const key of OFFLINE_MODEL_ENV_KEYS) {
    delete process.env[key];
  }
}
