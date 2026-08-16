import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DesktopReviewLayout } from "@/components/review/DesktopReviewLayout";
import type { CreateReviewResponse, Finding } from "@/lib/contracts/review";

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
    suggestion: extras?.suggestion ?? quote,
    confidence: extras?.confidence ?? 0.9,
    evidence: extras?.evidence ?? {
      type: "ai_judgment",
      summary: "测试依据",
      items: [],
    },
    status: "open",
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

function Harness() {
  const [resetCount, setResetCount] = useState(0);
  return (
    <DesktopReviewLayout
      key={resetCount}
      review={review}
      onReset={() => setResetCount((value) => value + 1)}
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
        onReset={() => undefined}
      />,
    );
    expect(screen.getByTestId("article-body").textContent).toContain("第一段有错别字座谈谈会。");
    expect(screen.getByTestId("finding-empty").textContent).toContain("未发现需要提示的问题");
  });
});
