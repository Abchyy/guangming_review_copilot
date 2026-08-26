import type { WebEvidenceFactCategory } from "@grc/contracts";

export type DomainAllowlistByCategory = Record<WebEvidenceFactCategory, readonly string[]>;

/**
 * Authoritative-domain allowlist keyed by fact category.
 * Query policy reads this table; collectors must not hard-code vendor domains.
 */
export const DEFAULT_DOMAIN_ALLOWLIST: DomainAllowlistByCategory = {
  person_title: ["gov.cn", "news.cn", "xinhuanet.com", "people.com.cn"],
  organization_name: ["gov.cn", "news.cn", "xinhuanet.com", "people.com.cn"],
  policy_regulation: ["gov.cn"],
  date: ["gov.cn", "news.cn", "xinhuanet.com", "people.com.cn"],
  number: ["gov.cn", "stats.gov.cn"],
  attribution: ["gov.cn", "news.cn", "xinhuanet.com", "people.com.cn"],
};

export function isAllowedWebEvidenceUrl(
  url: string,
  allowedDomains: readonly string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.length === 0) {
    return false;
  }
  return allowedDomains.some((domain) => {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}
