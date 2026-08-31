import { describe, expect, test } from "vitest";

import { buildFallbackRiskFindings } from "@grc/review-core";

const article = {
  title: "科技创新与爱国主义教育工作推进会召开",
  body: "2026年8月30日，材料称，“国家数据统计局”发布《2023年全国科技经费投入统计公报》。会议要求执行《中华人民共和国爱国主义教育法》。主持人宣读：“统计数据必须真实准确。”",
  version: 1,
};

describe("fallback risk findings", () => {
  test("creates conservative verification-only seeds for downstream review", () => {
    const findings = buildFallbackRiskFindings(article);
    expect(findings.map((item) => item.type)).toEqual([
      "organization",
      "policy",
      "citation",
      "datetime",
    ]);
    expect(findings.find((item) => item.type === "policy")?.source_span.quoted_text).toBe(
      "《中华人民共和国爱国主义教育法》",
    );
    expect(
      findings.every(
        (item) =>
          item.status === "verify" &&
          item.requires_verification === true &&
          item.suggestion.replacement === null,
      ),
    ).toBe(true);
    for (const finding of findings) {
      const text = finding.source_span.field === "title" ? article.title : article.body;
      expect(
        text.slice(finding.source_span.start_offset, finding.source_span.end_offset),
      ).toBe(finding.source_span.quoted_text);
    }
  });
});
