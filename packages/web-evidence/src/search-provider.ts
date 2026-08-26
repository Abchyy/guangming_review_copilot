import type { WebEvidenceProviderKind, WebEvidenceQuery, WebEvidenceResult } from "@grc/contracts";

/**
 * Single adapter boundary for web evidence search.
 * This stage ships only a fake offline implementation. A later live adapter
 * must implement this interface and must not be imported by review-core.
 */
export interface SearchProvider {
  readonly id: string;
  readonly kind: WebEvidenceProviderKind;
  search(query: WebEvidenceQuery): Promise<WebEvidenceResult>;
}
