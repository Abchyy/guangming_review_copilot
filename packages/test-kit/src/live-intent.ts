export const DEV_LIVE_INTENT = "BENCHMARK_DEV_LIVE";
export const REGRESSION_LIVE_INTENT = "BENCHMARK_REGRESSION_LIVE";
export const LOCKED_INTENT = "BENCHMARK_LOCKED";
export const LIVE_SMOKE_INTENT = "LIVE_SMOKE";

export function requireExplicitIntent(flag: string, usage: string): void {
  if (process.env[flag] !== "1") {
    throw new Error(
      `Refusing to start without explicit opt-in (${flag}=1). ${usage} An API key is not a start condition.`,
    );
  }
}

export function requireEnvApiKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required after explicit opt-in. It is a run condition, not a start condition.`,
    );
  }
  return value;
}
