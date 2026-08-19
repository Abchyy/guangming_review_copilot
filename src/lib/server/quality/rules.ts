import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type {
  CanonicalArticle,
  FindingType,
  Severity,
  SourceSpan,
  Suggestion,
} from "@/lib/contracts/review";
import { fieldText, paragraphIndexAt } from "@/lib/server/span-locator";
import { RULE_VERSION } from "@/lib/server/quality/versions";
import { canonicalWorkspaceRoot } from "@/lib/server/workspace-identity";

const catalogSchema = z.object({
  rule_version: z.string(),
  default_calendar_year: z.number().int(),
  typos: z.array(
    z.object({
      rule_id: z.string(),
      wrong: z.string().min(1),
      correct: z.string().min(1),
    }),
  ),
  standard_phrases: z.array(
    z.object({
      rule_id: z.string(),
      wrong: z.string().min(1),
      correct: z.string().min(1),
      type: z.enum(["policy", "basic_text", "organization"]),
    }),
  ),
  entities: z.array(
    z.object({
      rule_id: z.string(),
      canonical_term: z.string().min(1),
      type: z.enum(["person", "organization"]),
      wrong_quotes: z.array(
        z.object({
          quoted: z.string().min(1),
          replacement: z.string().nullable(),
        }),
      ),
    }),
  ),
  metrics: z.array(
    z.object({
      rule_id: z.string(),
      label: z.string().min(1),
      number_re: z.string().min(1),
    }),
  ),
});

export type RuleHit = {
  rule_id: string;
  type: FindingType;
  severity: Severity;
  title: string;
  reason: string;
  suggestion: Suggestion;
  source_span: SourceSpan;
  confidence: number;
};

let cachedCatalog: z.infer<typeof catalogSchema> | null = null;

export function loadRuleCatalog(): z.infer<typeof catalogSchema> {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  const filePath = join(canonicalWorkspaceRoot(), "data", "rules", "catalog.json");
  cachedCatalog = catalogSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  return cachedCatalog;
}

export function getRuleVersion(): string {
  return loadRuleCatalog().rule_version || RULE_VERSION;
}

function makeSpan(
  article: CanonicalArticle,
  field: SourceSpan["field"],
  start: number,
  quoted: string,
): SourceSpan {
  const text = fieldText(article, field);
  const end = start + quoted.length;
  if (text.slice(start, end) !== quoted) {
    throw new Error("Rule span does not match canonical text");
  }
  return {
    field,
    start_offset: start,
    end_offset: end,
    quoted_text: quoted,
    paragraph_index: paragraphIndexAt(text, start),
    article_version: article.version,
  };
}

function findAll(text: string, needle: string): number[] {
  const hits: number[] = [];
  if (needle.length === 0) {
    return hits;
  }
  let from = 0;
  while (from <= text.length - needle.length) {
    const start = text.indexOf(needle, from);
    if (start === -1) {
      break;
    }
    hits.push(start);
    from = start + needle.length;
  }
  return hits;
}

function weekdayNumber(token: string): number {
  if (token === "日" || token === "天") {
    return 0;
  }
  return "一二三四五六".indexOf(token) + 1;
}

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

function yearFromArticle(article: CanonicalArticle, fallback: number): number {
  const combined = `${article.title}\n${article.body}`;
  const match = combined.match(/(\d{4})年/);
  if (!match) {
    return fallback;
  }
  return Number(match[1]);
}

function scanRepeatedPunctuation(article: CanonicalArticle, field: SourceSpan["field"]): RuleHit[] {
  const text = fieldText(article, field);
  const hits: RuleHit[] = [];
  const pattern = /([。！？!?，、])\1+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const quoted = match[0];
    const replacement = match[1] ?? quoted[0]!;
    hits.push({
      rule_id: "punct.repeated",
      type: "basic_text",
      severity: "low",
      title: "连续重复标点",
      reason: `原文出现连续重复标点“${quoted}”，应按规范保留一个。`,
      suggestion: { text: `改为“${replacement}”。`, replacement },
      source_span: makeSpan(article, field, match.index, quoted),
      confidence: 1,
    });
  }
  return hits;
}

const BRACKET_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["[", "]"],
];

function scanUnclosedBrackets(article: CanonicalArticle, field: SourceSpan["field"]): RuleHit[] {
  const text = fieldText(article, field);
  const hits: RuleHit[] = [];
  for (const [open, close] of BRACKET_PAIRS) {
    let depth = 0;
    let lastOpen = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === open) {
        depth += 1;
        lastOpen = i;
      } else if (ch === close) {
        depth -= 1;
        if (depth < 0) {
          hits.push({
            rule_id: "punct.unclosed",
            type: "basic_text",
            severity: "medium",
            title: "括号或引号不配对",
            reason: `出现未匹配的“${close}”。`,
            suggestion: { text: "请人工补全或删除多余括号/引号。", replacement: null },
            source_span: makeSpan(article, field, i, close),
            confidence: 1,
          });
          depth = 0;
        }
      }
    }
    if (depth > 0 && lastOpen >= 0) {
      hits.push({
        rule_id: "punct.unclosed",
        type: "basic_text",
        severity: "medium",
        title: "括号或引号未闭合",
        reason: `出现未闭合的“${open}”。`,
        suggestion: { text: "请人工补全闭合符号。", replacement: null },
        source_span: makeSpan(article, field, lastOpen, open),
        confidence: 1,
      });
    }
  }

  const asciiQuotes = [...text].reduce((count, ch) => (ch === '"' ? count + 1 : count), 0);
  if (asciiQuotes % 2 === 1) {
    const last = text.lastIndexOf('"');
    hits.push({
      rule_id: "punct.unclosed",
      type: "basic_text",
      severity: "medium",
      title: "引号未闭合",
      reason: "ASCII 双引号数量为奇数，可能未闭合。",
      suggestion: { text: "请人工核对引号配对。", replacement: null },
      source_span: makeSpan(article, field, last, '"'),
      confidence: 0.9,
    });
  }
  return hits;
}

function scanDateWeekday(article: CanonicalArticle, field: SourceSpan["field"], year: number): RuleHit[] {
  const text = fieldText(article, field);
  const hits: RuleHit[] = [];
  const pattern = /((?:上|本)?(?:星期|周)([一二三四五六日天]))（(\d{1,2})月(\d{1,2})日）/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const claimedToken = match[2];
    const month = Number(match[3]);
    const day = Number(match[4]);
    if (!claimedToken || month < 1 || month > 12 || day < 1 || day > 31) {
      continue;
    }
    const actual = new Date(year, month - 1, day);
    if (actual.getMonth() !== month - 1 || actual.getDate() !== day) {
      continue;
    }
    const actualWeekday = actual.getDay();
    const claimedWeekday = weekdayNumber(claimedToken);
    if (claimedWeekday !== actualWeekday) {
      const quoted = match[0];
      const prefix = match[1] ?? "";
      const replacement = `${prefix.slice(0, prefix.length - 1)}${WEEKDAY_NAMES[actualWeekday]}（${month}月${day}日）`;
      hits.push({
        rule_id: "datetime.weekday-mismatch",
        type: "datetime",
        severity: "high",
        title: "日期与星期不一致",
        reason: `${year}年${month}月${day}日是星期${WEEKDAY_NAMES[actualWeekday]}，与稿件所写不一致。`,
        suggestion: { text: `改为“${replacement}”。`, replacement },
        source_span: makeSpan(article, field, match.index, quoted),
        confidence: 1,
      });
    }
  }
  return hits;
}

function scanExactReplacements(
  article: CanonicalArticle,
  field: SourceSpan["field"],
  items: Array<{
    rule_id: string;
    wrong: string;
    correct: string | null;
    type: FindingType;
    severity: Severity;
    title: string;
    reason: string;
  }>,
): RuleHit[] {
  const text = fieldText(article, field);
  const hits: RuleHit[] = [];
  for (const item of items) {
    for (const start of findAll(text, item.wrong)) {
      hits.push({
        rule_id: item.rule_id,
        type: item.type,
        severity: item.severity,
        title: item.title,
        reason: item.reason,
        suggestion: {
          text: item.correct == null ? "建议人工核实，无安全自动替换。" : `改为“${item.correct}”。`,
          replacement: item.correct,
        },
        source_span: makeSpan(article, field, start, item.wrong),
        confidence: 1,
      });
    }
  }
  return hits;
}

function scanMetrics(article: CanonicalArticle, field: SourceSpan["field"], catalog: ReturnType<typeof loadRuleCatalog>): RuleHit[] {
  const text = fieldText(article, field);
  const hits: RuleHit[] = [];
  for (const metric of catalog.metrics) {
    const numberRe = new RegExp(metric.number_re, "g");
    const labelStarts = findAll(text, metric.label);
    if (labelStarts.length === 0) {
      continue;
    }
    const values = new Map<string, Array<{ start: number; quoted: string }>>();
    for (const labelStart of labelStarts) {
      const window = text.slice(labelStart, Math.min(text.length, labelStart + metric.label.length + 24));
      numberRe.lastIndex = 0;
      const numberMatch = numberRe.exec(window);
      if (!numberMatch) {
        continue;
      }
      const quoted = window.slice(0, numberMatch.index + numberMatch[0].length);
      const absoluteStart = labelStart;
      const value = numberMatch[1] ?? numberMatch[0];
      const list = values.get(value) ?? [];
      list.push({ start: absoluteStart, quoted });
      values.set(value, list);
    }
    if (values.size < 2) {
      continue;
    }
    const distinct = [...values.keys()].join(" / ");
    for (const occurrences of values.values()) {
      for (const occurrence of occurrences) {
        hits.push({
          rule_id: metric.rule_id,
          type: "number",
          severity: "high",
          title: "同一指标出现不同数字",
          reason: `“${metric.label}”在文中出现不同数值（${distinct}），属于明确数据矛盾。`,
          suggestion: { text: "建议人工核实哪一个数字正确，无安全自动替换。", replacement: null },
          source_span: makeSpan(article, field, occurrence.start, occurrence.quoted),
          confidence: 1,
        });
      }
    }
  }
  return hits;
}

export function runRules(article: CanonicalArticle): RuleHit[] {
  const catalog = loadRuleCatalog();
  const year = yearFromArticle(article, catalog.default_calendar_year);
  const fields: Array<SourceSpan["field"]> = ["title", "body"];
  const hits: RuleHit[] = [];

  for (const field of fields) {
    hits.push(
      ...scanExactReplacements(
        article,
        field,
        catalog.typos.map((item) => ({
          rule_id: item.rule_id,
          wrong: item.wrong,
          correct: item.correct,
          type: "basic_text" as const,
          severity: "low" as const,
          title: "疑似错别字",
          reason: `“${item.wrong}”应为“${item.correct}”。`,
        })),
      ),
    );
    hits.push(
      ...scanExactReplacements(
        article,
        field,
        catalog.standard_phrases.map((item) => ({
          rule_id: item.rule_id,
          wrong: item.wrong,
          correct: item.correct,
          type: item.type,
          severity: "high" as const,
          title: "标准固定表述可能有误",
          reason: `稿件使用“${item.wrong}”，标准表述为“${item.correct}”。`,
        })),
      ),
    );
    for (const entity of catalog.entities) {
      const combined = `${article.title}\n${article.body}`;
      if (!combined.includes(entity.canonical_term)) {
        continue;
      }
      hits.push(
        ...scanExactReplacements(
          article,
          field,
          entity.wrong_quotes.map((item) => ({
            rule_id: entity.rule_id,
            wrong: item.quoted,
            correct: item.replacement,
            type: entity.type,
            severity: "high" as const,
            title: "人物职务或机构名称与 curated 条目矛盾",
            reason: `文中已出现“${entity.canonical_term}”，同时又出现与之矛盾的表述“${item.quoted}”。`,
          })),
        ),
      );
    }
    hits.push(...scanRepeatedPunctuation(article, field));
    hits.push(...scanUnclosedBrackets(article, field));
    hits.push(...scanDateWeekday(article, field, year));
    hits.push(...scanMetrics(article, field, catalog));
  }

  return hits;
}

export function knownRuleIds(): Set<string> {
  const catalog = loadRuleCatalog();
  return new Set([
    ...catalog.typos.map((item) => item.rule_id),
    ...catalog.standard_phrases.map((item) => item.rule_id),
    ...catalog.entities.map((item) => item.rule_id),
    ...catalog.metrics.map((item) => item.rule_id),
    "punct.repeated",
    "punct.unclosed",
    "datetime.weekday-mismatch",
  ]);
}
