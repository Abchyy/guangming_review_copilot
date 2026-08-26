import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  DesktopReviewLayout,
  REVIEW_COMPACT_MEDIA_QUERY,
} from "@/components/review/DesktopReviewLayout";
import { ReviewApp } from "@/components/review/ReviewApp";
import { SPECIALIST_DISABLED_MESSAGE } from "@/components/review/specialist-orchestration-view";
import type {
  CreateReviewResponse,
  Finding,
  SpecialistOrchestrationRun,
  WebEvidenceResult,
  WebEvidenceRun,
} from "@grc/contracts";
import {
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
  WEB_EVIDENCE_UNVERIFIED_MESSAGE,
  specialistOrchestrationRunSchema,
  unobservedSpecialistCallFields,
} from "@grc/contracts";

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

const retrievedAt = "2026-08-26T08:00:00.000Z";

function retrievedEvidence(overrides?: Partial<WebEvidenceResult>): WebEvidenceResult {
  return {
    evidence: [
      {
        source_name: "中国政府网",
        url: "https://www.gov.cn/example/wanghaitao",
        title: "市教育局局长王海涛出席基础教育座谈会",
        excerpt: "市教育局党委书记、局长王海涛出席会议并讲话。",
        published_or_version_date: "2026-01-15",
        retrieved_at: retrievedAt,
        source_tier: "official",
      },
    ],
    status: "retrieved",
    error_class: "none",
    message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
    provenance: {
      provider_id: "fake-offline",
      provider_kind: "fake_offline",
      live_network: false,
      retrieved_at: retrievedAt,
      query_text: "市教育局局长王海涛",
      fact_category: "person_title",
    },
    ...overrides,
  };
}

function unverifiedEvidence(overrides?: Partial<WebEvidenceResult>): WebEvidenceResult {
  return {
    evidence: [],
    status: "unverified",
    error_class: "not_found",
    message: WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    provenance: {
      provider_id: "fake-offline",
      provider_kind: "fake_offline",
      live_network: false,
      retrieved_at: retrievedAt,
      query_text: "义务教育阶段在校生",
      fact_category: "number",
    },
    ...overrides,
  };
}

function withWebEvidence(
  results: WebEvidenceResult[],
  extras?: Partial<CreateReviewResponse>,
): CreateReviewResponse {
  const run: WebEvidenceRun = {
    enabled: true,
    query_count: results.length,
    results,
  };
  return {
    ...review,
    ...extras,
    pipeline: {
      ...review.pipeline,
      ...extras?.pipeline,
      web_evidence: run,
    },
  };
}

const PERSON_QUOTE = "市教育局局长王海涛";
const CITATION_QUOTE = "王强在总结时强调开学工作";
const DISAGREEMENT_REASON = "专家结论存在分歧，待人工核实";
const TIMEOUT_REASON = "专项核验超时，待人工核实";

function specialistRun(extras: Partial<SpecialistOrchestrationRun> = {}): SpecialistOrchestrationRun {
  return specialistOrchestrationRunSchema.parse({
    enabled: true,
    target_model: "deepseek-v4-flash",
    dispatched: ["fact_check", "news_edit"],
    skipped: [],
    budget: { max_specialists: 2, used: 2 },
    results: [
      {
        taskId: "fact_check:1",
        candidates: [
          {
            type: "person",
            severity: "high",
            title: "职务待核验",
            reason: "人名与职务可能不匹配。",
            suggestion: { text: "核对公开职务", replacement: null },
            confidence: 0.72,
            evidence: [
              {
                kind: "internal_context",
                excerpt: PERSON_QUOTE,
                citation_validated: true,
              },
              {
                kind: "retrieved_source",
                excerpt: "市教育局党委书记、局长王海涛出席会议并讲话。",
                citation_validated: false,
                source_id: "source-edu-bureau",
                source_url: "https://example.invalid/edu",
              },
            ],
            source: {
              field: "body",
              exact_quote: PERSON_QUOTE,
              paragraph_index: 0,
              context_before: "上周四召开座谈会。",
              context_after: "出席会议并讲话。",
            },
          },
        ],
        provenance: {
          taskId: "fact_check:1",
          specialist: "fact_check",
          invoked: true,
          status: "succeeded",
          provider: "fixture",
          model: "fake-specialist",
          elapsedMs: 12,
          ...unobservedSpecialistCallFields(),
        },
        warnings: [],
      },
      {
        taskId: "news_edit:1",
        candidates: [
          {
            type: "citation",
            severity: "high",
            title: "引语归属待核验",
            reason: "总结发言人可能不是王强。",
            suggestion: { text: "改为王海涛", replacement: "王海涛在总结时强调开学工作" },
            confidence: 0.64,
            evidence: [
              {
                kind: "ai_judgment",
                excerpt: "仅根据文内信息判断，不能视为已证实。",
                citation_validated: false,
              },
            ],
            source: {
              field: "body",
              exact_quote: CITATION_QUOTE,
              paragraph_index: 0,
              context_before: null,
              context_after: null,
            },
          },
        ],
        provenance: {
          taskId: "news_edit:1",
          specialist: "news_edit",
          invoked: true,
          status: "succeeded",
          provider: "fixture",
          model: "fake-specialist",
          elapsedMs: 9,
          ...unobservedSpecialistCallFields(),
        },
        warnings: [],
      },
    ],
    judgments: [],
    warnings: [],
    ...extras,
  });
}

function withSpecialistOrchestration(
  run: SpecialistOrchestrationRun,
  extras?: Partial<CreateReviewResponse>,
): CreateReviewResponse {
  return {
    ...review,
    ...extras,
    pipeline: {
      ...review.pipeline,
      ...extras?.pipeline,
      specialist_orchestration: run,
    },
  };
}

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

function createMatchMedia(compact: boolean): typeof window.matchMedia {
  return (query: string) =>
    ({
      matches: query === REVIEW_COMPACT_MEDIA_QUERY ? compact : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

async function waitForCompactLayout() {
  await vi.waitFor(() => {
    expect(screen.getByTestId("desktop-review").getAttribute("data-compact")).toBe(
      "true",
    );
  });
}

describe("desktop vertical slice mapping", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(false);
  });

  test("renders the full article and finding highlights", () => {
    render(<Harness />);
    expect(screen.getByTestId("article-title").textContent).toContain("测试稿件标题");
    expect(screen.getByTestId("article-body").textContent).toContain("第一段有错别字座谈谈会。");
    expect(screen.getByTestId("article-body").textContent).toContain("第二段写王强在总结时强调。");
    expect(screen.getAllByTestId("source-mark").length).toBeGreaterThan(0);
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();
    expect(screen.getByTestId("finding-finding-002").textContent).toContain("严重");
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

  test("clicking a finding locate button scrolls to and emphasizes the source span", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("locate-finding-002"));
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
    window.matchMedia = createMatchMedia(false);
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
    expect(screen.getByTestId("action-toast").textContent).toContain("已接受");
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
    window.matchMedia = createMatchMedia(false);
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

  test("sheet toggle expands and collapses the findings sheet", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const shell = screen.getByTestId("desktop-review");
    expect(shell.className).toContain("is-sheet-collapsed");
    expect(screen.getByTestId("findings-sheet-panel").hidden).toBe(false);
    expect(screen.getByRole("combobox", { name: "风险" })).toBeTruthy();
    await user.click(screen.getByTestId("findings-sheet-toggle"));
    expect(shell.className).toContain("is-sheet-open");
    await user.click(screen.getByTestId("findings-sheet-toggle"));
    expect(shell.className).toContain("is-sheet-collapsed");
    expect(screen.getByRole("combobox", { name: "风险" })).toBeTruthy();
  });
});

describe("compact review sheet accessibility", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(true);
  });

  test("collapsed compact sheet only exposes the summary toggle", async () => {
    render(<Harness />);
    await waitForCompactLayout();
    const toggle = screen.getByTestId("findings-sheet-toggle");
    const panel = screen.getByTestId("findings-sheet-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("展开");
    expect(panel.hidden).toBe(true);
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("combobox", { name: "风险" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "类型" })).toBeNull();
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
    expect(screen.queryByRole("button", { name: "忽略" })).toBeNull();
    expect(screen.queryByRole("button", { name: "待核实" })).toBeNull();
    expect(screen.getByRole("button", { name: /审校意见 · 待处理/ })).toBeTruthy();
  });

  test("expanding the compact sheet restores filters, findings, and actions", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await waitForCompactLayout();
    await user.click(screen.getByTestId("findings-sheet-toggle"));
    const toggle = screen.getByTestId("findings-sheet-toggle");
    const panel = screen.getByTestId("findings-sheet-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("收起");
    expect(panel.hidden).toBe(false);
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("combobox", { name: "风险" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "类型" })).toBeTruthy();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "接受" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "忽略" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "待核实" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("finding-finding-001").textContent).toContain("测试依据");

    await user.selectOptions(screen.getByRole("combobox", { name: "风险" }), "critical");
    expect(screen.queryByTestId("finding-finding-001")).toBeNull();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("combobox", { name: "风险" })).toBeNull();
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
  });

  test("selecting a mark in compact layout opens the sheet and locates the finding", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await waitForCompactLayout();
    const mark = screen
      .getAllByTestId("source-mark")
      .find((element) => element.getAttribute("data-primary-finding-id") === "finding-001");
    expect(mark).toBeTruthy();
    await user.click(mark!);
    expect(screen.getByTestId("findings-sheet-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByTestId("findings-sheet-panel").hidden).toBe(false);
    expect(screen.getByTestId("finding-finding-001").className).toContain("is-selected");
    expect(screen.getAllByRole("button", { name: "接受" }).length).toBeGreaterThan(0);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  test("collapsed compact findings cannot take pointer or keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await waitForCompactLayout();
    const panel = screen.getByTestId("findings-sheet-panel");
    const accept = screen.getByTestId("accept-finding-001");
    const filter = screen.getByTestId("severity-filter");
    expect(accept.closest("[hidden]")).toBe(panel);
    expect(filter.closest("[inert]")).toBe(panel);
    expect(screen.queryByRole("button", { name: "接受" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "风险" })).toBeNull();
    screen.getByTestId("findings-sheet-toggle").focus();
    await user.tab();
    expect(document.activeElement).not.toBe(accept);
    expect(document.activeElement).not.toBe(filter);
    vi.stubGlobal("fetch", vi.fn());
    await user.click(accept);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("web evidence presentation", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(false);
  });

  test("does not render a panel when the pipeline omitted web evidence", () => {
    render(<Harness />);
    expect(screen.queryByTestId("web-evidence-panel")).toBeNull();
    expect(screen.queryByTestId("web-evidence-banner")).toBeNull();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });

  test("retrieved evidence shows status, source, title, url, excerpt, date, and tier", () => {
    render(<Harness initial={withWebEvidence([retrievedEvidence()])} />);
    const panel = screen.getByTestId("web-evidence-panel");
    expect(panel.textContent).toContain("已返回网页证据");
    expect(panel.textContent).toContain(WEB_EVIDENCE_RETRIEVED_MESSAGE);
    expect(panel.textContent).toContain("中国政府网");
    expect(panel.textContent).toContain("市教育局局长王海涛出席基础教育座谈会");
    expect(panel.textContent).toContain("市教育局党委书记、局长王海涛出席会议并讲话。");
    expect(panel.textContent).toContain("2026-01-15");
    expect(panel.textContent).toContain("官方");
    expect(panel.textContent).toContain("来源名称");
    expect(panel.textContent).toContain("标题");
    expect(panel.textContent).toContain("URL");
    expect(panel.textContent).toContain("短摘录");
    expect(panel.textContent).toContain("日期");
    expect(panel.textContent).toContain("来源等级");
    expect(panel.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.gov.cn/example/wanghaitao",
    );
    expect(screen.queryByTestId("web-evidence-banner")).toBeNull();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });

  test("unverified evidence is explicit and is not presented as 没有问题", () => {
    render(<Harness initial={withWebEvidence([unverifiedEvidence()])} />);
    expect(screen.getByTestId("web-evidence-banner").textContent).toContain(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(screen.getByTestId("web-evidence-banner").textContent).toContain(
      "不表示稿件没有问题",
    );
    expect(screen.getByTestId("web-evidence-status").textContent).toBe(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(screen.getByTestId("web-evidence-unverified-0").textContent).toContain(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(screen.getByTestId("web-evidence-panel").textContent).not.toContain("没有问题");
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
    expect(screen.getByTestId("finding-finding-001").textContent).toContain("测试依据");
  });

  test("empty findings with unverified evidence do not look like a clean bill", () => {
    render(
      <Harness
        initial={withWebEvidence([unverifiedEvidence()], {
          findings: [],
          pipeline: { ...review.pipeline, located_count: 0 },
        })}
      />,
    );
    expect(screen.getByTestId("article-body").textContent).toContain("第一段有错别字座谈谈会。");
    expect(screen.getByTestId("web-evidence-banner").textContent).toContain(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(screen.getByTestId("finding-empty").textContent).toContain("本轮无正文批注");
    expect(screen.getByTestId("finding-empty").textContent).toContain("不能视为没有问题");
    expect(screen.getByTestId("finding-empty").textContent).not.toContain(
      "未发现需要提示的问题",
    );
  });

  test("missing date is labeled instead of dropped", () => {
    const missingDate = retrievedEvidence({
      evidence: [
        {
          source_name: "新华网",
          url: "https://www.news.cn/example/wanghaitao",
          title: "王海涛：抓好开学工作",
          excerpt: "王海涛要求各地做好开学准备。",
          published_or_version_date: null,
          retrieved_at: retrievedAt,
          source_tier: "authoritative",
        },
      ],
    });
    render(<Harness initial={withWebEvidence([missingDate])} />);
    const item = screen.getByTestId("web-evidence-item-0-0");
    expect(item.textContent).toContain("日期未标明");
    expect(item.textContent).toContain("权威");
    expect(item.textContent).toContain("新华网");
  });

  test("reading mode, filters, and the findings sheet still work with web evidence", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withWebEvidence([retrievedEvidence(), unverifiedEvidence()])} />);
    expect(screen.getAllByTestId("source-mark").length).toBeGreaterThan(0);
    await user.click(screen.getByTestId("reading-mode-toggle"));
    expect(screen.queryAllByTestId("source-mark")).toHaveLength(0);
    expect(screen.getByTestId("web-evidence-panel")).toBeTruthy();
    expect(screen.getByTestId("web-evidence-banner").textContent).toContain(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );

    await user.selectOptions(screen.getByTestId("severity-filter"), "critical");
    expect(screen.queryByTestId("finding-finding-001")).toBeNull();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();
    expect(screen.getByTestId("web-evidence-panel")).toBeTruthy();
    expect(screen.getByTestId("findings-sheet")).toBeTruthy();
    expect(screen.getByTestId("findings-sheet-toggle")).toBeTruthy();
  });
});

describe("compact web evidence sheet", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(true);
  });

  test("collapsed compact sheet keeps unverified status visible without exposing details", async () => {
    render(<Harness initial={withWebEvidence([unverifiedEvidence()])} />);
    await waitForCompactLayout();
    const toggle = screen.getByTestId("findings-sheet-toggle");
    const panel = screen.getByTestId("findings-sheet-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain(WEB_EVIDENCE_UNVERIFIED_MESSAGE);
    expect(screen.getByTestId("web-evidence-banner").textContent).toContain(
      WEB_EVIDENCE_UNVERIFIED_MESSAGE,
    );
    expect(panel.hidden).toBe(true);
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "风险" })).toBeNull();
  });

  test("expanding the compact sheet reveals evidence fields and keeps filters", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withWebEvidence([retrievedEvidence()])} />);
    await waitForCompactLayout();
    await user.click(screen.getByTestId("findings-sheet-toggle"));
    expect(screen.getByTestId("findings-sheet-panel").hidden).toBe(false);
    expect(screen.getByTestId("web-evidence-panel").textContent).toContain("中国政府网");
    expect(screen.getByTestId("web-evidence-panel").textContent).toContain("来源等级");
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://www.gov.cn/example/wanghaitao",
    );
    expect(screen.getByRole("combobox", { name: "风险" })).toBeTruthy();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });
});

describe("specialist orchestration review wiring", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(false);
  });

  test("omitted specialist_orchestration is passed as disabled and does not imply a model call", () => {
    expect(review.pipeline).not.toHaveProperty("specialist_orchestration");
    render(<Harness />);
    const panel = screen.getByTestId("specialist-orchestration-panel");
    expect(panel.getAttribute("data-enabled")).toBe("false");
    expect(screen.getByTestId("specialist-orchestration-enabled").textContent).toBe("未启用");
    expect(screen.getByTestId("specialist-orchestration-summary").textContent).toBe(
      SPECIALIST_DISABLED_MESSAGE,
    );
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("未调用");
    expect(panel.textContent).not.toContain("已返回");
    expect(panel.textContent).not.toContain("已调用");
    expect(panel.textContent).not.toContain("目标模型");
    expect(panel.textContent).not.toContain("没有问题");
    expect(screen.queryByTestId("specialist-candidate-fact_check-0")).toBeNull();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });

  test("reads specialist_orchestration from the review pipeline and shows call status, fragments, candidates, and evidence", () => {
    render(<Harness initial={withSpecialistOrchestration(specialistRun())} />);
    const panel = screen.getByTestId("specialist-orchestration-panel");
    expect(panel.getAttribute("data-enabled")).toBe("true");
    expect(screen.getByTestId("specialist-orchestration-enabled").textContent).toBe("已启用");
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("已返回");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("已返回");
    expect(panel.textContent).toContain("审校片段");
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain(PERSON_QUOTE);
    expect(screen.getByTestId("specialist-candidate-fact_check-0").textContent).toContain(
      "职务待核验",
    );
    expect(panel.textContent).toContain("证据");
    expect(screen.getByTestId("specialist-evidence-fact_check-0-1").textContent).toContain(
      "检索来源",
    );
    expect(
      screen.getByTestId("specialist-evidence-fact_check-0-1").querySelector("a")?.getAttribute(
        "href",
      ),
    ).toBe("https://example.invalid/edu");
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
    expect(screen.queryByTestId("web-evidence-panel")).toBeNull();
  });

  test("timeout and disagreement reasons from the review response stay visible as 待人工核实", () => {
    const run = specialistRun({
      results: [
        {
          taskId: "fact_check:1",
          candidates: [],
          provenance: {
            taskId: "fact_check:1",
            specialist: "fact_check",
            invoked: true,
            status: "timed_out",
            provider: "fixture",
            model: "fake-specialist",
            elapsedMs: 2000,
            ...unobservedSpecialistCallFields(),
          },
          warnings: [TIMEOUT_REASON],
        },
        {
          taskId: "news_edit:1",
          candidates: [
            {
              type: "citation",
              severity: "high",
              title: "保留原文并核实",
              reason: "引语归属存在分歧。",
              suggestion: { text: "保留原文并核实", replacement: null },
              confidence: 0.5,
              evidence: [
                {
                  kind: "ai_judgment",
                  excerpt: "仅根据文内信息判断。",
                  citation_validated: false,
                },
              ],
              source: {
                field: "body",
                exact_quote: CITATION_QUOTE,
                paragraph_index: 0,
                context_before: null,
                context_after: null,
              },
            },
          ],
          provenance: {
            taskId: "news_edit:1",
            specialist: "news_edit",
            invoked: true,
            status: "succeeded",
            provider: "fixture",
            model: "fake-specialist",
            elapsedMs: 11,
            ...unobservedSpecialistCallFields(),
          },
          warnings: [],
        },
      ],
      judgments: [
        {
          field: "body",
          paragraph_index: 0,
          quoted_text: PERSON_QUOTE,
          decision: "verify",
          reason: TIMEOUT_REASON,
          specialist_ids: ["fact_check"],
          requires_verification: true,
        },
        {
          field: "body",
          paragraph_index: 0,
          quoted_text: CITATION_QUOTE,
          decision: "verify",
          reason: DISAGREEMENT_REASON,
          specialist_ids: ["fact_check", "news_edit"],
          requires_verification: true,
        },
      ],
    });
    render(<Harness initial={withSpecialistOrchestration(run)} />);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("调用超时");
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain(TIMEOUT_REASON);
    expect(screen.getByTestId("specialist-verify-1").textContent).toContain(DISAGREEMENT_REASON);
    expect(screen.getByTestId("findings-sheet-toggle").textContent).toContain("专项核验待核实");
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });

  test("reading mode, filters, and web evidence still work with specialist_orchestration", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={withWebEvidence([retrievedEvidence()], {
          pipeline: {
            ...review.pipeline,
            specialist_orchestration: specialistRun(),
          },
        })}
      />,
    );
    expect(screen.getByTestId("specialist-orchestration-panel")).toBeTruthy();
    expect(screen.getByTestId("web-evidence-panel")).toBeTruthy();
    await user.click(screen.getByTestId("reading-mode-toggle"));
    expect(screen.queryAllByTestId("source-mark")).toHaveLength(0);
    expect(screen.getByTestId("specialist-orchestration-panel").textContent).toContain("已启用");
    await user.selectOptions(screen.getByTestId("severity-filter"), "critical");
    expect(screen.queryByTestId("finding-finding-001")).toBeNull();
    expect(screen.getByTestId("finding-finding-002")).toBeTruthy();
    expect(screen.getByTestId("specialist-orchestration-panel")).toBeTruthy();
  });
});

describe("compact specialist orchestration sheet", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = createMatchMedia(true);
  });

  test("collapsed compact sheet hides specialist details until expanded", async () => {
    render(<Harness initial={withSpecialistOrchestration(specialistRun())} />);
    await waitForCompactLayout();
    const toggle = screen.getByTestId("findings-sheet-toggle");
    const panel = screen.getByTestId("findings-sheet-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "风险" })).toBeNull();
  });

  test("expanding the compact sheet reveals specialist results and keeps findings readable", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withSpecialistOrchestration(specialistRun())} />);
    await waitForCompactLayout();
    await user.click(screen.getByTestId("findings-sheet-toggle"));
    expect(screen.getByTestId("findings-sheet-panel").hidden).toBe(false);
    expect(screen.getByTestId("specialist-orchestration-panel").textContent).toContain(
      PERSON_QUOTE,
    );
    expect(screen.getByTestId("specialist-orchestration-panel").textContent).toContain("证据");
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.invalid/edu");
    expect(screen.getByRole("combobox", { name: "风险" })).toBeTruthy();
    expect(screen.getByTestId("finding-finding-001")).toBeTruthy();
  });

  test("collapsed compact sheet keeps verification status visible without exposing candidate links", async () => {
    const run = specialistRun({
      judgments: [
        {
          field: "body",
          paragraph_index: 0,
          quoted_text: CITATION_QUOTE,
          decision: "verify",
          reason: DISAGREEMENT_REASON,
          specialist_ids: ["fact_check", "news_edit"],
          requires_verification: true,
        },
      ],
    });
    render(<Harness initial={withSpecialistOrchestration(run)} />);
    await waitForCompactLayout();
    expect(screen.getByTestId("findings-sheet-toggle").textContent).toContain("专项核验待核实");
    expect(screen.getByTestId("findings-sheet-panel").hidden).toBe(true);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("article input page", () => {
  test("renders masthead, char count, and submit affordance", () => {
    render(<ReviewApp />);
    expect(screen.getByTestId("article-input")).toBeTruthy();
    expect(screen.getByTestId("body-count").textContent).toMatch(/\d+ 字/);
    expect(screen.getByTestId("start-review").textContent).toContain("开始审校");
  });

  test("shows loading state and error banner on failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "审校服务暂不可用" }),
      }),
    );
    render(<ReviewApp />);
    await user.click(screen.getByTestId("start-review"));
    expect((await screen.findByTestId("review-error")).textContent).toContain(
      "审校服务暂不可用",
    );
    vi.unstubAllGlobals();
  });
});
