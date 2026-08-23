import { describe, expect, test } from "vitest";

import { runRules } from "@grc/rules-engine";

describe("date year context", () => {
  test("does not treat a policy name year range as the article event year", () => {
    const hits = runRules({
      title: "学习教育强国建设规划纲要",
      body: "上周四（8月12日）召开座谈会。要学习《教育强国建设规划纲要（2023－2035年）》。",
      version: 1,
    });
    expect(hits.some((item) => item.rule_id === "datetime.weekday-mismatch")).toBe(true);
    expect(
      hits.some(
        (item) =>
          item.rule_id === "datetime.weekday-mismatch" &&
          item.source_span.quoted_text.includes("2035"),
      ),
    ).toBe(false);
  });

  test("uses a complete calendar date when the article states one", () => {
    const hits = runRules({
      title: "会议通知",
      body: "2024年8月12日召开座谈会，周三（8月12日）继续讨论。",
      version: 1,
    });
    expect(hits.some((item) => item.rule_id === "datetime.weekday-mismatch")).toBe(true);
    expect(
      hits
        .find((item) => item.rule_id === "datetime.weekday-mismatch")
        ?.reason.includes("2024年"),
    ).toBe(true);
  });
});
