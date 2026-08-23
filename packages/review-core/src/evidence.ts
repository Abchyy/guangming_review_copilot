import type {
  CanonicalArticle,
  EvidenceItem,
  Finding,
  LlmEvidenceItem,
  ReviewCandidate,
} from "@grc/contracts";
import { getCorpusById, knownSourceIds } from "@grc/retrieval";
import { knownRuleIds, type RuleHit } from "@grc/rules-engine";
import { locateUniqueExcerptSpans } from "./span-locator";

export type MaterializedCandidate = {
  candidate: ReviewCandidate;
  evidence: EvidenceItem[];
  requires_verification: boolean;
  dropped_unknown_ids: boolean;
};

function materializeRuleEvidence(hit: RuleHit): EvidenceItem {
  return {
    kind: "rule",
    excerpt: hit.reason,
    citation_validated: true,
    rule_id: hit.rule_id,
    article_spans: [hit.source_span],
  };
}

export function ruleHitToFindingDraft(hit: RuleHit): Omit<Finding, "finding_id"> {
  return {
    type: hit.type,
    severity: hit.severity,
    source_span: hit.source_span,
    title: hit.title,
    reason: hit.reason,
    suggestion: hit.suggestion,
    confidence: hit.confidence,
    evidence: [materializeRuleEvidence(hit)],
    status: "pending",
    requires_verification: false,
  };
}

export function materializeLlmEvidence(
  article: CanonicalArticle,
  candidate: ReviewCandidate,
): MaterializedCandidate {
  const allowedRules = knownRuleIds();
  const allowedSources = knownSourceIds();
  const evidence: EvidenceItem[] = [];
  let droppedUnknown = false;

  for (const item of candidate.evidence) {
    const materialized = materializeOne(article, item, allowedRules, allowedSources);
    if (materialized === "drop") {
      droppedUnknown = true;
      continue;
    }
    evidence.push(materialized);
  }

  if (candidate.rule_id && !allowedRules.has(candidate.rule_id)) {
    droppedUnknown = true;
  }
  if (candidate.source_id && !allowedSources.has(candidate.source_id)) {
    droppedUnknown = true;
  }

  if (evidence.length === 0) {
    return {
      candidate,
      evidence: [
        {
          kind: "ai_judgment",
          excerpt: candidate.reason,
          citation_validated: false,
        },
      ],
      requires_verification: true,
      dropped_unknown_ids: droppedUnknown,
    };
  }

  const hasReliable = evidence.some(
    (item) => item.kind === "rule" || item.kind === "retrieved_source",
  );
  return {
    candidate,
    evidence,
    requires_verification: !hasReliable,
    dropped_unknown_ids: droppedUnknown,
  };
}

function materializeOne(
  article: CanonicalArticle,
  item: LlmEvidenceItem,
  allowedRules: Set<string>,
  allowedSources: Set<string>,
): EvidenceItem | "drop" {
  if (item.kind === "rule") {
    const ruleId = item.rule_id;
    if (!ruleId || !allowedRules.has(ruleId)) {
      return "drop";
    }
    return {
      kind: "rule",
      excerpt: item.excerpt,
      citation_validated: item.citation_validated,
      rule_id: ruleId,
      article_spans: locateUniqueExcerptSpans(article, item.excerpt),
    };
  }

  if (item.kind === "retrieved_source") {
    const sourceId = item.source_id;
    if (!sourceId || !allowedSources.has(sourceId)) {
      return "drop";
    }
    const source = getCorpusById(sourceId);
    if (!source) {
      return "drop";
    }
    return {
      kind: "retrieved_source",
      excerpt: source.excerpt,
      citation_validated: true,
      source_id: source.source_id,
      source_name: source.source_name,
      source_url: source.source_url,
      source_version_date: source.published_at,
      authority_level: source.authority_level,
      article_spans: locateUniqueExcerptSpans(article, item.excerpt),
    };
  }

  return {
    kind: item.kind,
    excerpt: item.excerpt,
    citation_validated: item.citation_validated,
    article_spans: locateUniqueExcerptSpans(article, item.excerpt),
  };
}
