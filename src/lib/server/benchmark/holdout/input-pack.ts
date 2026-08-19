import { readFileSync } from "node:fs";

import { z } from "zod";

import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";
import { isPathInsideCanonicalWorkspace } from "@/lib/server/benchmark/holdout/freeze";
import { sha256Canonical } from "@/lib/server/benchmark/holdout/identity";
import { hashCanonicalArticle } from "@/lib/server/quality/article-hash";
import type { HoldoutRole } from "@/lib/server/benchmark/holdout/roles";

export const INPUT_PACK_SCHEMA_VERSION = "holdout-input.v1";

const inputArticleSchema = z
  .object({
    article_id: z.string().min(1),
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();

const inputPackFileSchema = z
  .object({
    schema_version: z.literal(INPUT_PACK_SCHEMA_VERSION),
    pack_id: z.string().min(1),
    role: z.enum(["dev", "regression", "locked", "protocol_fixture"]),
    articles: z.array(inputArticleSchema).min(1),
  })
  .strict();

export type InputArticle = z.infer<typeof inputArticleSchema>;

export type InputPack = {
  schema_version: typeof INPUT_PACK_SCHEMA_VERSION;
  pack_id: string;
  role: HoldoutRole;
  content_sha256: string;
  source_path: string;
  in_development_repo: boolean;
  articles: Array<InputArticle & { input_sha256: string }>;
};

function contentIdentity(packId: string, role: HoldoutRole, articles: InputArticle[]): string {
  return inputPackContentIdentity({
    pack_id: packId,
    role,
    articles,
  });
}

export function inputPackContentIdentity(pack: {
  pack_id: string;
  role: HoldoutRole;
  articles: Array<{ article_id: string; title: string; body: string }>;
}): string {
  return sha256Canonical({
    pack_id: pack.pack_id,
    role: pack.role,
    articles: pack.articles.map((item) => ({
      article_id: item.article_id,
      title: item.title,
      body: item.body,
    })),
  });
}

export function loadInputPack(filePath: string): InputPack {
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (raw && typeof raw === "object" && "articles" in raw) {
    const articles = (raw as { articles: unknown }).articles;
    if (Array.isArray(articles) && articles.some((item) => item && typeof item === "object" && "issues" in item)) {
      throw new HoldoutProtocolError(
        "Input-only pack must not contain gold issues. Use a hidden gold pack only during controlled evaluation.",
      );
    }
  }
  const parsed = inputPackFileSchema.parse(raw);
  const inRepo = isPathInsideCanonicalWorkspace(filePath);
  if (parsed.role === "locked" && inRepo) {
    throw new HoldoutProtocolError(
      "Official locked input must not be loaded from the development repo",
    );
  }
  return {
    schema_version: parsed.schema_version,
    pack_id: parsed.pack_id,
    role: parsed.role,
    content_sha256: contentIdentity(parsed.pack_id, parsed.role, parsed.articles),
    source_path: filePath,
    in_development_repo: inRepo,
    articles: parsed.articles.map((item) => ({
      ...item,
      input_sha256: hashCanonicalArticle(item.title, item.body),
    })),
  };
}
