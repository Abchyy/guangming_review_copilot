import { readFileSync } from "node:fs";

import { z } from "zod";

import { HoldoutProtocolError } from "./errors";
import { isPathInsideCanonicalWorkspace } from "./freeze";
import { sha256Canonical } from "./identity";
import type { GoldIssue } from "@grc/benchmark";
import { hashCanonicalArticle } from "@grc/review-core";
import type { HoldoutRole } from "./roles";

export const GOLD_PACK_SCHEMA_VERSION = "holdout-gold.v1";

const goldIssueSchema = z.object({
  issue_id: z.string().min(1),
  type: z.enum([
    "basic_text",
    "person",
    "organization",
    "datetime",
    "number",
    "policy",
    "citation",
    "consistency",
    "external_fact",
  ]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  field: z.enum(["title", "body"]),
  quoted_text: z.string().min(1),
  occurrence: z.number().int().nonnegative(),
  requires_evidence: z.boolean(),
});

const goldArticleSchema = z.object({
  article_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  issues: z.array(goldIssueSchema).min(1),
});

const goldPackFileSchema = z.object({
  schema_version: z.literal(GOLD_PACK_SCHEMA_VERSION),
  pack_id: z.string().min(1),
  role: z.enum(["dev", "regression", "locked", "protocol_fixture"]),
  articles: z.array(goldArticleSchema).min(1),
});

export type GoldPackArticle = {
  article_id: string;
  title: string;
  body: string;
  input_sha256: string;
  issues: GoldIssue[];
};

export type GoldPack = {
  schema_version: typeof GOLD_PACK_SCHEMA_VERSION;
  pack_id: string;
  role: HoldoutRole;
  content_sha256: string;
  source_path: string;
  in_development_repo: boolean;
  articles: GoldPackArticle[];
};

export function goldPackContentIdentity(pack: {
  pack_id: string;
  role: HoldoutRole;
  articles: Array<{
    article_id: string;
    title: string;
    body: string;
    issues: GoldIssue[];
  }>;
}): string {
  return sha256Canonical({
    pack_id: pack.pack_id,
    role: pack.role,
    articles: pack.articles.map((item) => ({
      article_id: item.article_id,
      title: item.title,
      body: item.body,
      issues: item.issues,
    })),
  });
}

export function loadGoldPack(filePath: string): GoldPack {
  const parsed = goldPackFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  const inRepo = isPathInsideCanonicalWorkspace(filePath);
  if (parsed.role === "locked" && inRepo) {
    throw new HoldoutProtocolError(
      "Official locked gold must not be loaded from the development repo",
    );
  }
  return {
    schema_version: parsed.schema_version,
    pack_id: parsed.pack_id,
    role: parsed.role,
    content_sha256: goldPackContentIdentity(parsed),
    source_path: filePath,
    in_development_repo: inRepo,
    articles: parsed.articles.map((item) => ({
      ...item,
      input_sha256: hashCanonicalArticle(item.title, item.body),
    })),
  };
}
