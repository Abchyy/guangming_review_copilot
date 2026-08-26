import type { CanonicalArticle, ReviewCandidate, ReviewExecutionProvenance, ReviewProvider } from "@grc/contracts";

export type ReviewPromptMode = "baseline" | "copilot";

export type RetrievedPromptSource = {
  source_id: string;
  source_name: string;
  category: string;
  excerpt: string;
};

export type RulePromptHit = {
  rule_id: string;
  title: string;
  excerpt: string;
};

export type ReviewPromptContext = {
  promptMode?: ReviewPromptMode;
  retrievedSources?: RetrievedPromptSource[];
  ruleHits?: RulePromptHit[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
};

export type ProviderCallUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  latency_ms: number;
};

export type SpecialistJsonCompletion = {
  system: string;
  user: string;
  signal?: AbortSignal;
  maxTokens?: number;
  maxAttempts?: number;
  maxRetries?: number;
  timeoutMs?: number;
};

export interface ReviewModel {
  readonly provider: ReviewProvider;
  readonly model: string | null;
  review(article: CanonicalArticle, context?: ReviewPromptContext): Promise<ReviewCandidate[]>;
  completeJson?(input: SpecialistJsonCompletion): Promise<ReviewCandidate[]>;
  consumeLastUsage?(): ProviderCallUsage | null;
  consumeLastProvenance?(): ReviewExecutionProvenance | null;
}
