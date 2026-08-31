import type { ArticleField, CanonicalArticle, Finding, SourceSpan } from "@grc/contracts";

import type { DraftFinding } from "./fusion";
import { paragraphIndexAt } from "./span-locator";

const FALLBACK_RISK_LIMIT = 6;

type RiskSeed = {
  type: Finding["type"];
  severity: Finding["severity"];
  field: ArticleField;
  start: number;
  quoted: string;
  title: string;
  reason: string;
};

function textOf(article: CanonicalArticle, field: ArticleField): string {
  return field === "title" ? article.title : article.body;
}

function spanOf(article: CanonicalArticle, seed: RiskSeed): SourceSpan {
  const text = textOf(article, seed.field);
  return {
    field: seed.field,
    start_offset: seed.start,
    end_offset: seed.start + seed.quoted.length,
    quoted_text: seed.quoted,
    paragraph_index: paragraphIndexAt(text, seed.start),
    article_version: article.version,
  };
}

function seedToFinding(article: CanonicalArticle, seed: RiskSeed): DraftFinding {
  const sourceSpan = spanOf(article, seed);
  return {
    type: seed.type,
    severity: seed.severity,
    source_span: sourceSpan,
    title: seed.title,
    reason: seed.reason,
    suggestion: {
      text: "主审校未完成，请结合专项核验或权威来源人工确认。",
      replacement: null,
    },
    confidence: 0.5,
    evidence: [
      {
        kind: "internal_context",
        excerpt: seed.quoted,
        citation_validated: true,
        article_spans: [sourceSpan],
      },
    ],
    status: "verify",
    requires_verification: true,
  };
}

function firstOrganizationSeed(article: CanonicalArticle): RiskSeed | undefined {
  for (const field of ["title", "body"] as const) {
    const text = textOf(article, field);
    const match = /[“"]([^”"\n]{2,40}(?:局|委员会|办公室|中心|部门))[”"]/g.exec(text);
    const quoted = match?.[1];
    if (match?.index != null && quoted) {
      return {
        type: "organization",
        severity: "medium",
        field,
        start: match.index + match[0].indexOf(quoted),
        quoted,
        title: "具名机构信息待核实",
        reason: "主审校未完成，稿件中的具名机构需要对照权威来源核实。",
      };
    }
  }
  return undefined;
}

function firstPolicySeed(article: CanonicalArticle): RiskSeed | undefined {
  const matches: Array<RiskSeed & { priority: number }> = [];
  for (const field of ["title", "body"] as const) {
    const text = textOf(article, field);
    for (const match of text.matchAll(/《[^》\n]{2,80}》/g)) {
      const quoted = match[0];
      if (match.index == null || !/(?:法|条例|规定|办法|规划|纲要|公报)/.test(quoted)) {
        continue;
      }
      const priority = /(?:法|条例|规定|办法)》$/.test(quoted)
        ? 0
        : /(?:规划|纲要)》$/.test(quoted)
          ? 1
          : 2;
      matches.push({
        type: "policy",
        severity: "medium",
        field,
        start: match.index,
        quoted,
        title: "具名政策文件待核实",
        reason: "主审校未完成，文件名称、版本或施行信息需要对照权威文本核实。",
        priority,
      });
    }
  }
  matches.sort((left, right) => left.priority - right.priority || left.start - right.start);
  const selected = matches[0];
  if (!selected) {
    return undefined;
  }
  return {
    type: selected.type,
    severity: selected.severity,
    field: selected.field,
    start: selected.start,
    quoted: selected.quoted,
    title: selected.title,
    reason: selected.reason,
  };
}

function firstCitationSeed(article: CanonicalArticle): RiskSeed | undefined {
  for (const field of ["title", "body"] as const) {
    const text = textOf(article, field);
    for (const match of text.matchAll(/“([^”\n]{6,100})”/g)) {
      const quoted = match[1];
      if (match.index == null || !quoted || /(?:局|委员会|办公室|中心|部门)$/.test(quoted)) {
        continue;
      }
      const windowStart = Math.max(0, match.index - 32);
      const windowEnd = Math.min(text.length, match.index + match[0].length + 32);
      const context = text.slice(windowStart, windowEnd);
      if (!/(?:表示|指出|强调|宣读|声称|出自|发言|说道|说)/.test(context)) {
        continue;
      }
      return {
        type: "citation",
        severity: "medium",
        field,
        start: match.index + match[0].indexOf(quoted),
        quoted,
        title: "引语归属待核实",
        reason: "主审校未完成，引语内容及其归属需要结合上下文人工核实。",
      };
    }
  }
  return undefined;
}

function firstDateSeed(article: CanonicalArticle): RiskSeed | undefined {
  for (const field of ["title", "body"] as const) {
    const text = textOf(article, field);
    const match = /\d{4}年\d{1,2}月\d{1,2}日/g.exec(text);
    if (match?.index != null) {
      return {
        type: "datetime",
        severity: "medium",
        field,
        start: match.index,
        quoted: match[0],
        title: "明确日期待核实",
        reason: "主审校未完成，稿件中的明确日期及时间关系需要人工核实。",
      };
    }
  }
  return undefined;
}

/**
 * Produces conservative verification-only seeds after the main reviewer fails.
 * These seeds never assert that a claim is wrong and never provide an automatic replacement.
 */
export function buildFallbackRiskFindings(article: CanonicalArticle): DraftFinding[] {
  const seeds = [
    firstOrganizationSeed(article),
    firstPolicySeed(article),
    firstCitationSeed(article),
    firstDateSeed(article),
  ].filter((seed): seed is RiskSeed => seed != null);

  return seeds.slice(0, FALLBACK_RISK_LIMIT).map((seed) => seedToFinding(article, seed));
}
