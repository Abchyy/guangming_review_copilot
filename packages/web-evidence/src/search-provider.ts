import type { WebEvidenceProviderKind, WebEvidenceQuery, WebEvidenceResult } from "@grc/contracts";

/**
 * Single adapter boundary for web evidence search.
 * Live adapters (Tavily) implement this interface and must not be imported by
 * review-core. Fake results must never be labeled live.
 */
export type SearchProviderOptions = {
  signal?: AbortSignal;
};

export interface SearchProvider {
  readonly id: string;
  readonly kind: WebEvidenceProviderKind;
  search(query: WebEvidenceQuery, options?: SearchProviderOptions): Promise<WebEvidenceResult>;
}
