import type {
  CanonicalArticle,
  FindingType,
  SpecialistPreliminaryFinding,
  SpecialistRetrievedEvidence,
  SpecialistRuntimeInput,
} from "@grc/contracts";

import type {
  AgentOrchestrationDevCase,
  AgentOrchestrationDevDataset,
  TriggerKind,
} from "../agent-orchestration-eval/schema";

export function syntheticFindingTypeForCase(item: AgentOrchestrationDevCase): FindingType | null {
  const trigger: TriggerKind = item.trigger_kind;
  if (trigger === "none") {
    return null;
  }
  if (trigger === "basic_text") {
    return "basic_text";
  }
  if (item.specialist === "news_edit") {
    return "consistency";
  }
  if (trigger === "policy") {
    return "policy";
  }
  if (trigger === "numeric") {
    return "number";
  }
  if (trigger === "citation") {
    return "external_fact";
  }
  if (trigger === "entity") {
    return /局长|主任|发言人|部长/.test(item.candidate_span.span_quote) ? "person" : "organization";
  }
  return "external_fact";
}

function shouldEmitFinding(item: AgentOrchestrationDevCase): boolean {
  if (item.trigger_kind === "basic_text") {
    return true;
  }
  return item.should_dispatch || item.duplicate_of != null;
}

function spanOffsets(
  body: string,
  quote: string,
  occurrence: "first" | "last",
): { start: number; end: number } | null {
  const start = occurrence === "last" ? body.lastIndexOf(quote) : body.indexOf(quote);
  if (start < 0) {
    return null;
  }
  return { start, end: start + quote.length };
}

function findingFromCase(
  item: AgentOrchestrationDevCase,
  body: string,
): SpecialistPreliminaryFinding | undefined {
  const type = syntheticFindingTypeForCase(item);
  if (type == null || !shouldEmitFinding(item)) {
    return undefined;
  }
  const offsets = spanOffsets(body, item.candidate_span.span_quote, item.duplicate_of ? "last" : "first");
  if (!offsets) {
    throw new Error(`${item.case_id}: span_quote not found in synthetic article body`);
  }
  return {
    type,
    severity: type === "basic_text" ? "low" : "high",
    title: `合成夹具 ${item.trigger_kind}`,
    reason: item.adjudication_hint,
    source_span: {
      field: "body",
      start_offset: offsets.start,
      end_offset: offsets.end,
      quoted_text: item.candidate_span.span_quote,
      paragraph_index: 0,
      article_version: 1,
    },
    suggestion: { text: item.adjudication_hint, replacement: null },
    confidence: 0.7,
  };
}

function evidenceFromCase(item: AgentOrchestrationDevCase): SpecialistRetrievedEvidence[] {
  return item.fixture_evidence.map((entry, index) => ({
    source_id: entry.locator,
    source_name: "synthetic-fixture",
    source_url: entry.locator,
    authority_level: entry.authority_level,
    published_at: item.as_of,
    valid_from: item.as_of,
    valid_to: null,
    excerpt: entry.excerpt,
    match_rank: index + 1,
    trigger: item.candidate_span.span_quote,
  }));
}

export function buildSyntheticSpecialistRuntimeInput(
  articleId: string,
  cases: readonly AgentOrchestrationDevCase[],
): SpecialistRuntimeInput {
  const articleCases = cases.filter((item) => item.article_id === articleId);
  if (articleCases.length === 0) {
    throw new Error(`No synthetic cases for article ${articleId}`);
  }
  const body = articleCases[0]!.article_excerpt;
  const article: CanonicalArticle = {
    title: articleId,
    body,
    version: 1,
  };
  const findings: SpecialistPreliminaryFinding[] = [];
  const evidence: SpecialistRetrievedEvidence[] = [];
  const seenEvidence = new Set<string>();
  for (const item of articleCases) {
    const finding = findingFromCase(item, body);
    if (finding) {
      findings.push(finding);
    }
    for (const entry of evidenceFromCase(item)) {
      if (seenEvidence.has(entry.source_id)) {
        continue;
      }
      seenEvidence.add(entry.source_id);
      evidence.push(entry);
    }
  }
  return {
    article,
    findings,
    retrievedEvidence: evidence,
  };
}

export function buildSyntheticSpecialistRuntimeInputs(
  dataset: AgentOrchestrationDevDataset,
): Map<string, SpecialistRuntimeInput> {
  const articleIds = [...new Set(dataset.cases.map((item) => item.article_id))];
  return new Map(
    articleIds.map((articleId) => [
      articleId,
      buildSyntheticSpecialistRuntimeInput(articleId, dataset.cases),
    ]),
  );
}
