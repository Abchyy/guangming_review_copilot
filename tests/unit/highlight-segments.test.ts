import { describe, expect, test } from "vitest";

import { segmentField } from "@/lib/highlight-segments";
import type { Finding } from "@grc/contracts";

function spanFinding(
  id: string,
  start: number,
  end: number,
  severity: Finding["severity"],
): Finding {
  return {
    finding_id: id,
    type: "basic_text",
    severity,
    source_span: {
      field: "body",
      start_offset: start,
      end_offset: end,
      quoted_text: "abcdefghij".slice(start, end),
      paragraph_index: 0,
      article_version: 1,
    },
    title: id,
    reason: "overlap",
    suggestion: { text: "x", replacement: "x" },
    confidence: 0.5,
    evidence: [{ kind: "ai_judgment", excerpt: "test", citation_validated: false }],
    status: "pending",
  };
}

describe("highlight segmentation", () => {
  test("splits overlapping spans instead of nesting marks", () => {
    const text = "abcdefghij";
    const segments = segmentField(
      text,
      [spanFinding("a", 0, 6, "low"), spanFinding("b", 3, 9, "critical")],
      "body",
    );
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.some((segment) => segment.text === "def")).toBe(true);
    const overlap = segments.find((segment) => segment.text === "def");
    expect(overlap?.findingIds).toEqual(["b", "a"]);
    expect(overlap?.primaryFindingId).toBe("b");
  });
});
