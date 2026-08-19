import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { BenchmarkArticle } from "@/lib/server/benchmark/evaluate";
import { canonicalWorkspaceRoot } from "@/lib/server/workspace-identity";

const issueSchema = z.object({
  issue_id: z.string(),
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

const datasetSchema = z.object({
  dataset_version: z.string(),
  role_policy: z.object({
    dev: z.literal("development_diagnosis_tuning"),
    regression: z.literal("legacy_contaminated_not_official_locked"),
  }),
  regression_contamination: z.object({
    reason: z.literal("inference_assets"),
    former_role: z.literal("locked"),
    may_claim_fresh_locked_generalization: z.literal(false),
  }),
  articles: z.array(
    z.object({
      article_id: z.string(),
      split: z.enum(["dev", "regression"]),
      title: z.string(),
      body: z.string(),
      issues: z.array(issueSchema),
    }),
  ),
});

export type BenchmarkDataset = z.infer<typeof datasetSchema>;

export function loadBenchmarkDataset(): BenchmarkDataset {
  const filePath = join(canonicalWorkspaceRoot(), "data", "benchmark", "dataset.json");
  const dataset = datasetSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  if (dataset.articles.some((item) => (item.split as string) === "locked")) {
    throw new Error("In-repo dataset must not contain official locked gold");
  }
  return dataset;
}

export function selectDevArticles(dataset: BenchmarkDataset = loadBenchmarkDataset()): BenchmarkArticle[] {
  return dataset.articles.filter((item) => item.split === "dev");
}

export function selectRegressionArticles(
  dataset: BenchmarkDataset = loadBenchmarkDataset(),
): BenchmarkArticle[] {
  return dataset.articles.filter((item) => item.split === "regression");
}
