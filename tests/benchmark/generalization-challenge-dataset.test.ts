/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

const issueSchema = z
  .object({
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
    expected_correction: z.string().min(1),
    rationale: z.string().min(1),
    evidence_url: z.string().url().optional(),
  })
  .superRefine((issue, context) => {
    if (issue.requires_evidence && !issue.evidence_url) {
      context.addIssue({
        code: "custom",
        message: "evidence_url is required when requires_evidence is true",
      });
    }
  });

const datasetSchema = z.object({
  dataset_version: z.literal("generalization-challenge-v1.0.0"),
  role: z.literal("adversarial_dev"),
  official: z.literal(false),
  may_claim_fresh_locked_generalization: z.literal(false),
  construction: z.object({
    method: z.string().min(1),
    source_text_copied: z.literal(false),
    intended_use: z.literal("development diagnosis and robustness regression"),
    forbidden_claim: z.literal("official_locked_generalization"),
  }),
  articles: z.array(
    z.object({
      article_id: z.string().min(1),
      origin: z.enum(["synthetic_from_public_facts", "fully_synthetic"]),
      difficulty_tags: z.array(z.string().min(1)).min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      source_references: z.array(
        z.object({
          authority: z.string().min(1),
          url: z.string().url(),
          accessed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          facts_used: z.string().min(1),
        }),
      ),
      issues: z.array(issueSchema),
    }),
  ),
});

function loadDataset() {
  const path = join(process.cwd(), "data", "benchmark", "generalization-challenge-v1.json");
  return datasetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function occurrenceCount(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const found = text.indexOf(needle, offset);
    if (found < 0) {
      break;
    }
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

describe("generalization challenge dataset", () => {
  test("is explicitly public adversarial development data, never a locked claim", () => {
    const dataset = loadDataset();
    expect(dataset.role).toBe("adversarial_dev");
    expect(dataset.official).toBe(false);
    expect(dataset.may_claim_fresh_locked_generalization).toBe(false);
    expect(dataset.construction.source_text_copied).toBe(false);
  });

  test("contains hard mixed-origin coverage and clean negative controls", () => {
    const dataset = loadDataset();
    const issues = dataset.articles.flatMap((article) => article.issues);
    const types = new Set(issues.map((issue) => issue.type));
    const tags = new Set(dataset.articles.flatMap((article) => article.difficulty_tags));

    expect(dataset.articles).toHaveLength(12);
    expect(issues.length).toBeGreaterThanOrEqual(36);
    expect(dataset.articles.filter((article) => article.issues.length === 0)).toHaveLength(2);
    expect(dataset.articles.filter((article) => article.origin === "synthetic_from_public_facts").length).toBeGreaterThanOrEqual(8);
    expect(types).toEqual(
      new Set([
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
    );
    for (const required of [
      "clean_control",
      "policy_version",
      "unit_magnitude",
      "linked_statistics",
      "percentage_math",
      "quote_attribution",
    ]) {
      expect(tags.has(required), required).toBe(true);
    }
  });

  test("keeps IDs unique and every gold quote exactly locatable", () => {
    const dataset = loadDataset();
    const articleIds = new Set<string>();
    const issueIds = new Set<string>();

    for (const article of dataset.articles) {
      expect(articleIds.has(article.article_id), article.article_id).toBe(false);
      articleIds.add(article.article_id);
      if (article.origin === "synthetic_from_public_facts") {
        expect(article.source_references.length, article.article_id).toBeGreaterThan(0);
      }
      for (const issue of article.issues) {
        expect(issueIds.has(issue.issue_id), issue.issue_id).toBe(false);
        issueIds.add(issue.issue_id);
        const text = issue.field === "title" ? article.title : article.body;
        const count = occurrenceCount(text, issue.quoted_text);
        expect(count, `${article.article_id}/${issue.issue_id}`).toBeGreaterThan(issue.occurrence);
        expect(issue.expected_correction).not.toBe(issue.quoted_text);
        if (issue.evidence_url) {
          expect(
            article.source_references.some((source) => source.url === issue.evidence_url),
            `${article.article_id}/${issue.issue_id}`,
          ).toBe(true);
        }
      }
    }
  });
});
