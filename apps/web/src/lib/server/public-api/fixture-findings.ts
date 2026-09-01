import { findingSchema, type Finding, type PublicReviewResource } from "@grc/contracts";

export function buildFixtureFindings(article: PublicReviewResource["article"]): Finding[] {
  const field = article.body.length > 0 ? "body" : "title";
  const text = field === "body" ? article.body : article.title;
  const quoted = text.slice(0, Math.min(2, text.length));
  return [
    findingSchema.parse({
      finding_id: "finding_fixture_1",
      type: "basic_text",
      severity: "low",
      source_span: {
        field,
        start_offset: 0,
        end_offset: quoted.length,
        quoted_text: quoted,
        paragraph_index: 0,
        article_version: article.version,
      },
      title: "示例表述待核",
      reason: "fixture 审校结果仅供联调，最终判断由用户负责。",
      suggestion: {
        text: "请人工确认该表述。",
        replacement: quoted,
      },
      confidence: 0.5,
      evidence: [
        {
          kind: "rule",
          excerpt: quoted,
          citation_validated: true,
          rule_id: "fixture.sample",
        },
      ],
      status: "pending",
    }),
  ];
}

export type FixtureDirective =
  | "queued"
  | "running"
  | "succeeded"
  | "degraded"
  | "failed"
  | "rejected";

export function readFixtureDirective(title: string, body: string): FixtureDirective | null {
  const text = `${title}\n${body}`;
  const match = text.match(/\[fixture:(queued|running|succeeded|degraded|failed|rejected)\]/i);
  const value = match?.[1]?.toLowerCase();
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "degraded" ||
    value === "failed" ||
    value === "rejected"
  ) {
    return value;
  }
  return null;
}
