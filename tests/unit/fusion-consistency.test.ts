import { describe, expect, test } from "vitest";

import type { Finding } from "@grc/contracts";
import { fuseFindings, type DraftFinding } from "@grc/review-core";

function draft(
  overrides: Partial<DraftFinding> & Pick<DraftFinding, "reason" | "suggestion">,
): DraftFinding {
  return {
    type: "basic_text",
    severity: "low",
    source_span: {
      field: "body",
      start_offset: 0,
      end_offset: 4,
      quoted_text: "座谈谈会",
      paragraph_index: 0,
      article_version: 1,
    },
    title: "错别字",
    confidence: 0.8,
    evidence: [
      {
        kind: "rule",
        excerpt: "规则命中",
        citation_validated: true,
        rule_id: "typo.zuotanhui",
      },
    ],
    status: "pending",
    requires_verification: false,
    ...overrides,
  };
}

describe("fusion semantic consistency", () => {
  test("keeps the winner reason and suggestion together when merging the same span", () => {
    const rule = draft({
      reason: "规则：座谈谈会应为座谈会。",
      suggestion: { text: "改为座谈会。", replacement: "座谈会" },
      confidence: 0.55,
      requires_verification: true,
    });
    const llm = draft({
      reason: "模型给出了更长但不配套的解释，不应单独覆盖规则建议。",
      suggestion: { text: "改成讨论会。", replacement: "座谈会" },
      confidence: 0.99,
      requires_verification: false,
      evidence: [{ kind: "ai_judgment", excerpt: "模型判断", citation_validated: false }],
    });
    const fused = fuseFindings([rule], [llm]);
    expect(fused).toHaveLength(1);
    const item = fused[0]!;
    expect(item.reason).toBe(rule.reason);
    expect(item.suggestion).toEqual(rule.suggestion);
    expect(item.confidence).toBe(rule.confidence);
    expect(item.requires_verification).toBe(true);
    expect(item.evidence.some((entry) => entry.kind === "rule")).toBe(true);
    expect(item.evidence.some((entry) => entry.kind === "ai_judgment")).toBe(true);
  });

  test("merged finding remains a valid Finding shape after id assignment", () => {
    const fused = fuseFindings(
      [
        draft({
          reason: "规则原因",
          suggestion: { text: "改", replacement: "座谈会" },
        }),
      ],
      [
        draft({
          reason: "模型原因更长一些所以旧实现会偷换理由",
          suggestion: { text: "改", replacement: "座谈会" },
          evidence: [{ kind: "ai_judgment", excerpt: "x", citation_validated: false }],
        }),
      ],
    );
    const asFinding: Finding = {
      ...fused[0]!,
      finding_id: "finding-001",
    };
    expect(asFinding.reason.startsWith("规则")).toBe(true);
    expect(asFinding.suggestion.replacement).toBe("座谈会");
  });
});
