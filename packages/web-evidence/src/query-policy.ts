import type {
  CanonicalArticle,
  FindingType,
  WebEvidenceCandidateFact,
  WebEvidenceFactCategory,
  WebEvidenceQuery,
} from "@grc/contracts";
import {
  WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
  WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  webEvidenceQuerySchema,
} from "@grc/contracts";

import {
  DEFAULT_DOMAIN_ALLOWLIST,
  type DomainAllowlistByCategory,
} from "./domain-allowlist";
import { minimizeFactClaim, normalizeFactClaim } from "./privacy";

export const HIGH_RISK_FINDING_CATEGORIES: Partial<
  Record<FindingType, WebEvidenceFactCategory>
> = {
  person: "person_title",
  organization: "organization_name",
  policy: "policy_regulation",
  datetime: "date",
  number: "number",
  citation: "attribution",
  external_fact: "attribution",
};

export const WEB_EVIDENCE_FACT_PRIORITY: Record<WebEvidenceFactCategory, number> = {
  person_title: 0,
  organization_name: 1,
  policy_regulation: 2,
  attribution: 3,
  date: 4,
  number: 5,
};

export function isHighRiskFindingType(type: FindingType): boolean {
  return HIGH_RISK_FINDING_CATEGORIES[type] != null;
}

export function factsFromFindings(
  findings: ReadonlyArray<{
    type: FindingType;
    title: string;
    source_span: { quoted_text: string };
  }>,
): WebEvidenceCandidateFact[] {
  const facts: WebEvidenceCandidateFact[] = [];
  for (const finding of findings) {
    const category = HIGH_RISK_FINDING_CATEGORIES[finding.type];
    if (!category) {
      continue;
    }
    const quoted = normalizeFactClaim(finding.source_span.quoted_text);
    const claim = quoted.length >= 2 ? quoted : normalizeFactClaim(finding.title);
    if (claim.length < 2) {
      continue;
    }
    facts.push({ category, claim });
  }
  return facts;
}

export type PlanWebEvidenceQueriesInput = {
  facts: readonly WebEvidenceCandidateFact[];
  article?: Pick<CanonicalArticle, "title" | "body">;
  allowlist?: DomainAllowlistByCategory;
  language?: string;
  region?: string;
  maxQueries?: number;
  maxResultsPerQuery?: number;
};

export function planWebEvidenceQueries(
  input: PlanWebEvidenceQueriesInput,
): WebEvidenceQuery[] {
  const allowlist = input.allowlist ?? DEFAULT_DOMAIN_ALLOWLIST;
  const maxQueries = clampLimit(
    input.maxQueries ?? WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
    WEB_EVIDENCE_MAX_QUERIES_PER_ARTICLE,
  );
  const maxResults = clampLimit(
    input.maxResultsPerQuery ?? WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
    WEB_EVIDENCE_MAX_RESULTS_PER_QUERY,
  );
  const ranked = [...input.facts]
    .map((fact, index) => ({ fact, index }))
    .sort((left, right) => {
      const byCategory =
        WEB_EVIDENCE_FACT_PRIORITY[left.fact.category] -
        WEB_EVIDENCE_FACT_PRIORITY[right.fact.category];
      if (byCategory !== 0) {
        return byCategory;
      }
      return left.index - right.index;
    });

  const queries: WebEvidenceQuery[] = [];
  const seen = new Set<string>();
  for (const { fact } of ranked) {
    if (queries.length >= maxQueries) {
      break;
    }
    const queryText = minimizeFactClaim(fact.claim, input.article);
    if (!queryText) {
      continue;
    }
    const dedupeKey = `${fact.category}:${queryText}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    queries.push(
      webEvidenceQuerySchema.parse({
        query_text: queryText,
        fact_category: fact.category,
        allowed_domains: [...allowlist[fact.category]],
        language: input.language ?? "zh-CN",
        region: input.region ?? "CN",
        max_results: maxResults,
      }),
    );
  }
  return queries;
}

function clampLimit(requested: number, ceiling: number): number {
  if (!Number.isFinite(requested) || requested < 1) {
    return ceiling;
  }
  return Math.min(Math.floor(requested), ceiling);
}
