import { createHash } from "node:crypto";

export function hashCanonicalArticle(title: string, body: string): string {
  return createHash("sha256").update(`${title}\n${body}`, "utf8").digest("hex");
}

export function buildCandidateCacheKey(parts: {
  articleHash: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  ruleVersion: string;
  corpusVersion: string;
  outputSchemaVersion: string;
  promptMode: string;
}): string {
  return createHash("sha256")
    .update(
      [
        parts.articleHash,
        parts.provider,
        parts.model ?? "null",
        parts.promptVersion,
        parts.ruleVersion,
        parts.corpusVersion,
        parts.outputSchemaVersion,
        parts.promptMode,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}
