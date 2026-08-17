import type Database from "better-sqlite3";

import type { ReviewCandidate } from "@/lib/contracts/review";

export class LlmCandidateCache {
  constructor(private readonly db: Database.Database) {}

  get(cacheKey: string): ReviewCandidate[] | null {
    const row = this.db
      .prepare(`SELECT candidates_json FROM llm_candidate_cache WHERE cache_key = ?`)
      .get(cacheKey) as { candidates_json: string } | undefined;
    if (!row) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(row.candidates_json);
      if (!Array.isArray(parsed)) {
        return null;
      }
      return parsed as ReviewCandidate[];
    } catch {
      return null;
    }
  }

  set(cacheKey: string, meta: {
    provider: string;
    model: string | null;
    promptVersion: string;
    ruleVersion: string;
    corpusVersion: string;
    outputSchemaVersion: string;
    articleHash: string;
    candidates: ReviewCandidate[];
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO llm_candidate_cache (
          cache_key, provider, model, prompt_version, rule_version,
          corpus_version, output_schema_version, article_hash,
          candidates_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cacheKey,
        meta.provider,
        meta.model,
        meta.promptVersion,
        meta.ruleVersion,
        meta.corpusVersion,
        meta.outputSchemaVersion,
        meta.articleHash,
        JSON.stringify(meta.candidates),
        new Date().toISOString(),
      );
  }
}
