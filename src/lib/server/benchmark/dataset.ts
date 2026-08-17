import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { BenchmarkArticle } from "@/lib/server/benchmark/evaluate";

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
  articles: z.array(
    z.object({
      article_id: z.string(),
      split: z.enum(["dev", "locked"]),
      title: z.string(),
      body: z.string(),
      issues: z.array(issueSchema),
    }),
  ),
});

export function loadBenchmarkDataset(): {
  dataset_version: string;
  articles: BenchmarkArticle[];
} {
  const filePath = join(process.cwd(), "data", "benchmark", "dataset.json");
  return datasetSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}
