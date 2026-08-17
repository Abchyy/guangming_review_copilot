export type DeepSeekUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
};

const PEAK_INPUT_MISS = 0.44;
const PEAK_INPUT_HIT = 0.014;
const PEAK_OUTPUT = 1.32;
const OFFPEAK_INPUT_MISS = 0.22;
const OFFPEAK_INPUT_HIT = 0.007;
const OFFPEAK_OUTPUT = 0.66;

function isPeakUtc(now: Date): boolean {
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateDeepSeekCostUsd(usage: DeepSeekUsage, now = new Date()): number | null {
  if (usage.input_tokens == null || usage.output_tokens == null) {
    return null;
  }
  const peak = isPeakUtc(now);
  const inputHitPrice = peak ? PEAK_INPUT_HIT : OFFPEAK_INPUT_HIT;
  const inputMissPrice = peak ? PEAK_INPUT_MISS : OFFPEAK_INPUT_MISS;
  const outputPrice = peak ? PEAK_OUTPUT : OFFPEAK_OUTPUT;
  const cached = Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens);
  const miss = usage.input_tokens - cached;
  return (cached * inputHitPrice + miss * inputMissPrice + usage.output_tokens * outputPrice) / 1_000_000;
}
