import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CORPUS_VERSION } from "@/lib/server/quality/versions";

export const corpusReferenceSchema = z.object({
  source_id: z.string().min(1),
  category: z.enum([
    "person",
    "organization",
    "policy",
    "meeting",
    "document",
    "phrase",
    "keyword",
  ]),
  canonical_term: z.string().min(1),
  aliases: z.array(z.string()),
  keywords: z.array(z.string()),
  claims: z.array(z.string()),
  excerpt: z.string().min(1),
  source_name: z.string().min(1),
  source_url: z.string().min(1),
  authority_level: z.enum(["official", "internal"]),
  published_at: z.string(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  curated_at: z.string(),
  corpus_version: z.string(),
});

const corpusFileSchema = z.object({
  corpus_version: z.string(),
  references: z.array(corpusReferenceSchema),
});

export type CorpusReference = z.infer<typeof corpusReferenceSchema>;

let cachedCorpus: z.infer<typeof corpusFileSchema> | null = null;

export function loadCorpus(): z.infer<typeof corpusFileSchema> {
  if (cachedCorpus) {
    return cachedCorpus;
  }
  const filePath = join(process.cwd(), "data", "corpus", "references.json");
  cachedCorpus = corpusFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  return cachedCorpus;
}

export function getCorpusVersion(): string {
  return loadCorpus().corpus_version || CORPUS_VERSION;
}

export function getCorpusById(sourceId: string): CorpusReference | undefined {
  return loadCorpus().references.find((item) => item.source_id === sourceId);
}

export function knownSourceIds(): Set<string> {
  return new Set(loadCorpus().references.map((item) => item.source_id));
}
