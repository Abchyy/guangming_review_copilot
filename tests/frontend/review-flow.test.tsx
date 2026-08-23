import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DesktopReviewLayout } from "@/components/review/DesktopReviewLayout";
import type { CreateReviewResponse, Finding } from "@grc/contracts";

const articleBody = "第一段有错别字座谈谈会。\n\n第二段写王强在总结时强调。";

function finding(
  id: string,
  quote: string,
  extras?: Partial<Finding>,
): Finding {
  const start = articleBody.indexOf(quote);
  return {
    finding_id: id,
    type: extras?.type ?? "basic_text",
    severity: extras?.severity ?? "low",
    source_span: {
      field: "body",
      start_offset: start,
      end_offset: start + quote.length,
      quoted_text: quote,
      paragraph_index: quote === "王强在总结时强调" ? 2 : 0,
      article_version: 1,
    },
    title: extras?.title ?? `问题 ${id}`,
    reason: extras?.reason ?? "测试原因",
    suggestion: extras?.suggestion ?? {
      text: quote,
      replacement: extras?.suggestion?.replacement ?? quote,
    },
    confidence: extras?.confidence ?? 0.9,
    evidence: extras?.evidence ?? [
      { kind: "ai_judgment", excerpt: "测试依据", citation_validated: false },
    ],
    status: extras?.status ?? "pending",
  };
}

const review: CreateReviewResponse = {
  review_id: "review-test",
  article: {
    title: "测试稿件标题",
    body: articleBody,
    version: 1,
  },
  findings: [
    finding("finding-001", "座谈谈会", {
      title: "多字",
      type: "basic_text",
      severity: "low",
    }),
    finding("finding-002", "王强在总结时强调", {
      title: "人物可能有误",
      type: "person",
      severity: "critical",
    }),
  ],
  pipeline: {
    provider: "fixture",
    model: null,
    candidate_count: 2,
    located_count: 2,
    dropped_count: 0,
    elapsed_ms: 1,
  },
};

function Harness({ initial = review }: { initial?: CreateReviewResponse }) {
  const [current, setCurrent] = useState(initial);
  return (
    <DesktopReviewLayout
      review={current}
      onReviewChange={setCurrent}
      onReset={() => setCurrent(initial)}
    />
  );
}

describe("desktop vertical slice mapping", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  test("renders the full article and finding highlights", () => {
    render(<Harness />);
    expect(screen.getByTestId("article-title").textContent).toContain("测试稿件标题");
    expect(screen.getByTestId("article-body").textContent).toContain("第一段有错别字座谈谈会。");
    expect(screen.getByTestId("article-body").textContent).toContain("第二段写王强在总结时强调。");
    expect(screen.getAllByTestId("source-mark").length).toBeGreaterThan(0);
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();
    expect(screen.getByTestId("finding-finding-002").textContent).toContain("Critical");
    expect(screen.getByTestId("finding-finding-001").textContent).toContain("测试依据");
  });

  test("clicking a highlight selects the corresponding finding", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const mark = screen
      .getAllByTestId("source-mark")
      .find((element) => element.getAttribute("data-primary-finding-id") === "finding-001");
    expect(mark).toBeTruthy();
    await user.click(mark!);
    expect(screen.getByTestId("finding-finding-001").className).toContain("is-selected");
    expect(screen.getByTestId("desktop-review").className).toContain("is-sheet-open");
  });

  test("clicking a finding scrolls to and emphasizes the source span", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("finding-finding-002"));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    const mark = screen
      .getAllByTestId("source-mark")
      .find((element) => element.getAttribute("data-primary-finding-id") === "finding-002");
    expect(mark?.className).toContain("finding-flash");
    expect(screen.getByTestId("finding-finding-002").className).toContain("is-selected");
  });

  test("empty findings still render the full article", () => {
    render(
      <DesktopReviewLayout
        review={{ ...review, findings: [], pipeline: { ...review.pipeline, located_count: 0 } }}
        onReviewChange={() => undefined}
        onReset={() => undefined}
      />,
    );
    expect(screen.getByTestId("article-body").textContent).toContain("第一段有错别字座谈谈会。");
    expect(screen.getByTestId("finding-empty").textContent).toContain("未发现需要提示的问题");
  });
});

describe("desktop review workflow", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.restoreAllMocks();
  });

  test("null replacement disables Accept", () => {
    const unsafe = {
      ...review,
      findings: [
        finding("finding-001", "座谈谈会", {
          suggestion: { text: "建议人工核实", replacement: null },
        }),
      ],
    };
    render(<Harness initial={unsafe} />);
    expect((screen.getByTestId("accept-finding-001") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("no-safe-replacement-finding-001")).toBeTruthy();
    expect((screen.getByTestId("ignore-finding-001") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("verify-finding-001") as HTMLButtonElement).disabled).toBe(false);
  });

  test("Accept replaces the article from the server snapshot", async () => {
    const user = userEvent.setup();
    const nextReview: CreateReviewResponse = {
      ...review,
      article: {
        ...review.article,
        body: articleBody.replace("座谈谈会", "座谈会"),
        version: 2,
      },
      findings: [
        {
          ...review.findings[0]!,
          status: "accepted",
          source_span: {
            ...review.findings[0]!.source_span,
            quoted_text: "座谈会",
            end_offset:
              review.findings[0]!.source_span.start_offset + "座谈会".length,
          },
        },
        review.findings[1]!,
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => nextReview,
      }),
    );
    render(<Harness />);
    await user.click(screen.getByTestId("accept-finding-001"));
    expect(screen.getByTestId("article-body").textContent).toContain("座谈会");
    expect(screen.getByTestId("finding-finding-001").textContent).toContain("已接受");
    expect(screen.getByTestId("finding-finding-002").className).toContain("is-selected");
  });

  test("Ignore and Verify show status without mutating article", async () => {
    const user = userEvent.setup();
    const ignored: CreateReviewResponse = {
      ...review,
      findings: [{ ...review.findings[0]!, status: "ignored" }, review.findings[1]!],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ignored,
      }),
    );
    render(<Harness />);
    const before = screen.getByTestId("article-body").textContent;
    await user.click(screen.getByTestId("ignore-finding-001"));
    expect(screen.getByTestId("article-body").textContent).toBe(before);
    expect(screen.getByTestId("finding-finding-001").textContent).toContain("已忽略");
  });

  test("failed action does not mutate the article", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ code: "STALE_ARTICLE", error: "Article version mismatch" }),
      }),
    );
    render(<Harness />);
    const before = screen.getByTestId("article-body").textContent;
    await user.click(screen.getByTestId("accept-finding-001"));
    expect(screen.getByTestId("article-body").textContent).toBe(before);
    expect(screen.getByTestId("action-error").textContent).toContain("Article version mismatch");
  });

  test("action loading disables buttons", async () => {
    const user = userEvent.setup();
    let resolveFetch: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    render(<Harness />);
    const click = user.click(screen.getByTestId("accept-finding-001"));
    await vi.waitFor(() => {
      expect(screen.getByTestId("accept-finding-001").textContent).toContain("处理中");
    });
    resolveFetch?.({
      ok: true,
      json: async () => review,
    });
    await click;
  });
});

describe("P0 reading mode, filters, evidence, fallback, and mobile sheet", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  test("reading mode hides source marks", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getAllByTestId("source-mark").length).toBeGreaterThan(0);
    await user.click(screen.getByTestId("reading-mode-toggle"));
    expect(screen.queryAllByTestId("source-mark")).toHaveLength(0);
    expect(screen.getByTestId("article-body").textContent).toContain("座谈谈会");
  });

  test("risk and type filters hide unmatched findings but keep the list chrome", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByTestId("severity-filter"), "critical");
    expect(screen.queryByTestId("finding-finding-001")).toBeNull();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();
    await user.selectOptions(screen.getByTestId("type-filter"), "basic_text");
    expect(screen.getByTestId("finding-filter-empty")).toBeTruthy();
    expect(screen.getByTestId("severity-filter")).toBeTruthy();
  });

  test("retrieved evidence renders name, url, and excerpt", () => {
    const withSource = {
      ...review,
      findings: [
        finding("finding-001", "座谈谈会", {
          evidence: [
            {
              kind: "retrieved_source",
              excerpt: "教育部公开说明",
              citation_validated: true,
              source_id: "src.edu",
              source_name: "教育部",
              source_url: "https://www.moe.gov.cn/example",
              source_version_date: "2024-05-01",
              authority_level: "official",
            },
          ],
        }),
      ],
    };
    render(<Harness initial={withSource} />);
    const card = screen.getByTestId("finding-finding-001");
    expect(card.textContent).toContain("教育部");
    expect(card.textContent).toContain("官方来源");
    expect(card.textContent).toContain("教育部公开说明");
    expect(card.textContent).toContain("2024-05-01");
    expect(card.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.moe.gov.cn/example",
    );
  });

  test("fallback banner is shown when the pipeline degraded", () => {
    render(
      <Harness
        initial={{
          ...review,
          pipeline: {
            ...review.pipeline,
            fallback: { used: true, mode: "rules_only", reason: "upstream unavailable" },
            specialists_enabled: false,
          },
        }}
      />,
    );
    expect(screen.getByTestId("fallback-banner").textContent).toContain("规则结果");
    expect(screen.getByTestId("findings-sheet")).toBeTruthy();
    expect(screen.getByTestId("findings-sheet-toggle")).toBeTruthy();
  });
});
