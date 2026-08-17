import type { CanonicalArticle } from "@/lib/contracts/review";
import { getCorpusById, loadCorpus, type CorpusReference } from "@/lib/server/quality/corpus";

export type RetrievedSource = CorpusReference & {
  match_rank: number;
  trigger: string;
};

const MAX_PER_TRIGGER = 2;
const MAX_TOTAL = 5;

function isValidOn(reference: CorpusReference, now: Date): boolean {
  const from = Date.parse(reference.valid_from);
  const to = reference.valid_to ? Date.parse(reference.valid_to) : Number.POSITIVE_INFINITY;
  const ts = now.getTime();
  return ts >= from && ts <= to;
}

function authorityScore(reference: CorpusReference): number {
  return reference.authority_level === "official" ? 2 : 1;
}

function paragraphKeywordOverlap(paragraphs: string[], keywords: string[]): number {
  let score = 0;
  for (const paragraph of paragraphs) {
    for (const keyword of keywords) {
      if (keyword.length > 0 && paragraph.includes(keyword)) {
        score += 1;
      }
    }
  }
  return score;
}

export function retrieveCorpus(
  article: CanonicalArticle,
  now = new Date(),
): RetrievedSource[] {
  const combined = `${article.title}\n${article.body}`;
  const paragraphs = combined.split("\n");
  const corpus = loadCorpus().references.filter((item) => isValidOn(item, now));
  const byTrigger = new Map<string, RetrievedSource[]>();

  for (const reference of corpus) {
    let rank = 0;
    let trigger: string | null = null;
    if (combined.includes(reference.canonical_term)) {
      rank = 400;
      trigger = reference.canonical_term;
    } else {
      const alias = reference.aliases.find((item) => item.length > 0 && combined.includes(item));
      if (alias) {
        rank = 300;
        trigger = alias;
      } else {
        const keyword = reference.keywords.find((item) => item.length > 0 && combined.includes(item));
        if (keyword) {
          rank = 200;
          trigger = keyword;
        }
      }
    }
    if (!trigger) {
      continue;
    }
    const overlap = paragraphKeywordOverlap(paragraphs, reference.keywords);
    const scored: RetrievedSource = {
      ...reference,
      trigger,
      match_rank: rank + overlap * 10 + authorityScore(reference),
    };
    const list = byTrigger.get(trigger) ?? [];
    list.push(scored);
    byTrigger.set(trigger, list);
  }

  const limited: RetrievedSource[] = [];
  for (const list of byTrigger.values()) {
    list.sort((a, b) => b.match_rank - a.match_rank || a.source_id.localeCompare(b.source_id));
    limited.push(...list.slice(0, MAX_PER_TRIGGER));
  }
  limited.sort((a, b) => b.match_rank - a.match_rank || a.source_id.localeCompare(b.source_id));
  const unique: RetrievedSource[] = [];
  const seen = new Set<string>();
  for (const item of limited) {
    if (seen.has(item.source_id)) {
      continue;
    }
    seen.add(item.source_id);
    unique.push(item);
    if (unique.length >= MAX_TOTAL) {
      break;
    }
  }
  return unique;
}

export function isAuthoritativeSource(sourceId: string | undefined): boolean {
  if (!sourceId) {
    return false;
  }
  return getCorpusById(sourceId)?.authority_level === "official";
}
