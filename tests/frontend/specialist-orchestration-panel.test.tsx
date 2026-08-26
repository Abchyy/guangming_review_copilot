import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { SpecialistOrchestrationPanel } from "@/components/review/SpecialistOrchestrationPanel";
import {
  SPECIALIST_DISABLED_MESSAGE,
  SPECIALIST_EMPTY_CANDIDATES_MESSAGE,
  SPECIALIST_ENABLED_MESSAGE,
  SPECIALIST_ENABLED_NOT_DISPATCHED_MESSAGE,
  hasPendingSpecialistVerification,
  specialistOrchestrationView,
} from "@/components/review/specialist-orchestration-view";
import type {
  ReviewCandidate,
  SpecialistJudgment,
  SpecialistOrchestrationRun,
  SpecialistResult,
} from "@grc/contracts";
import { specialistOrchestrationRunSchema, unobservedSpecialistCallFields } from "@grc/contracts";

const PERSON_QUOTE = "市教育局局长王海涛";
const CITATION_QUOTE = "王强在总结时强调开学工作";

const TIMEOUT_REASON = "专项核验超时，待人工核实";
const FAILURE_REASON = "专项核验失败，待人工核实";
const PARTIAL_FAILURE_REASON = "专项核验部分失败，待人工核实";
const DISAGREEMENT_REASON = "专家结论存在分歧，待人工核实";

function personCandidate(overrides?: Partial<ReviewCandidate>): ReviewCandidate {
  return {
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
    ...overrides,
  };
}

function citationCandidate(overrides?: Partial<ReviewCandidate>): ReviewCandidate {
  return {
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
    ...overrides,
  };
}

function result(input: {
  specialist: "fact_check" | "news_edit";
  status: SpecialistResult["provenance"]["status"];
  invoked?: boolean;
  candidates?: ReviewCandidate[];
  warnings?: string[];
  elapsedMs?: number;
}): SpecialistResult {
  return {
    taskId: `${input.specialist}:1`,
    candidates: input.candidates ?? [],
    provenance: {
      taskId: `${input.specialist}:1`,
      specialist: input.specialist,
      invoked: input.invoked ?? true,
      status: input.status,
      provider: "fixture",
      model: "fake-specialist",
      elapsedMs: input.elapsedMs ?? 12,
      ...unobservedSpecialistCallFields(),
    },
    warnings: input.warnings ?? [],
  };
}

function judgment(input: {
  quoted_text: string;
  decision: SpecialistJudgment["decision"];
  reason: string;
  specialist_ids: SpecialistJudgment["specialist_ids"];
  requires_verification: boolean;
}): SpecialistJudgment {
  return {
    field: "body",
    paragraph_index: 0,
    quoted_text: input.quoted_text,
    decision: input.decision,
    reason: input.reason,
    specialist_ids: input.specialist_ids,
    requires_verification: input.requires_verification,
  };
}

function enabledRun(
  extras: Partial<SpecialistOrchestrationRun> &
    Pick<SpecialistOrchestrationRun, "dispatched" | "results" | "judgments">,
): SpecialistOrchestrationRun {
  const parsed = specialistOrchestrationRunSchema.parse({
    enabled: true,
    target_model: "deepseek-v4-flash",
    skipped: [],
    budget: { max_specialists: 2, used: extras.dispatched.length },
    warnings: [],
    ...extras,
  });
  return parsed;
}

function panelText(run?: SpecialistOrchestrationRun | null): string {
  render(<SpecialistOrchestrationPanel run={run} />);
  return screen.getByTestId("specialist-orchestration-panel").textContent ?? "";
}

describe("specialist orchestration panel: default off", () => {
  test("omitted run shows 未启用 and does not imply a model call", () => {
    const text = panelText();
    expect(screen.getByTestId("specialist-orchestration-enabled").textContent).toBe("未启用");
    expect(screen.getByTestId("specialist-orchestration-summary").textContent).toBe(
      SPECIALIST_DISABLED_MESSAGE,
    );
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-call-fact_check").getAttribute("data-invoked")).toBe(
      "false",
    );
    expect(screen.getByTestId("specialist-call-news_edit").getAttribute("data-invoked")).toBe(
      "false",
    );
    expect(text).not.toContain("已启用");
    expect(text).not.toContain("已返回");
    expect(text).not.toContain("已调用");
    expect(text).not.toContain("调用失败");
    expect(text).not.toContain("调用超时");
    expect(text).not.toContain("目标模型");
    expect(text).not.toContain("审校片段");
    expect(text).not.toContain("候选意见");
    expect(text).not.toContain("没有问题");
    expect(text).not.toContain("未发现");
    expect(screen.queryByTestId("specialist-fragment-0")).toBeNull();
    expect(screen.queryByTestId("specialist-candidate-fact_check-0")).toBeNull();
    expect(screen.queryByTestId("specialist-verify-0")).toBeNull();
    expect(hasPendingSpecialistVerification(undefined)).toBe(false);
  });

  test("null run uses the same disabled copy as an omitted run", () => {
    const view = specialistOrchestrationView(null);
    expect(view.enabled).toBe(false);
    expect(view.calls.every((item) => item.invoked === false)).toBe(true);
    expect(view.fragments).toEqual([]);
    expect(view.candidates).toEqual([]);
    expect(view.verifications).toEqual([]);
    expect(panelText(null)).toContain(SPECIALIST_DISABLED_MESSAGE);
  });
});

describe("specialist orchestration panel: enabled success", () => {
  const run = enabledRun({
    dispatched: ["fact_check", "news_edit"],
    results: [
      result({
        specialist: "fact_check",
        status: "succeeded",
        candidates: [personCandidate()],
      }),
      result({
        specialist: "news_edit",
        status: "succeeded",
        candidates: [
          citationCandidate({
            suggestion: { text: "保留原文并核实", replacement: null },
          }),
        ],
      }),
    ],
    judgments: [
      judgment({
        quoted_text: PERSON_QUOTE,
        decision: "keep",
        reason: "多视角结论一致，或仅有单一相关视角成功返回。",
        specialist_ids: ["fact_check"],
        requires_verification: false,
      }),
    ],
  });

  test("shows enablement, call status, fragments, candidates, and evidence", () => {
    const text = panelText(run);
    expect(screen.getByTestId("specialist-orchestration-enabled").textContent).toBe("已启用");
    expect(text).toContain(SPECIALIST_ENABLED_MESSAGE);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("已返回");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("已返回");
    expect(screen.getByTestId("specialist-call-fact_check").getAttribute("data-invoked")).toBe(
      "true",
    );
    expect(text).toContain("审校片段");
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain(PERSON_QUOTE);
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain("上周四召开座谈会。");
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain("出席会议并讲话。");
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain("正文");
    expect(screen.getByTestId("specialist-candidate-fact_check-0").textContent).toContain(
      "职务待核验",
    );
    expect(screen.getByTestId("specialist-candidate-news_edit-0").textContent).toContain(
      "引语归属待核验",
    );
    expect(text).toContain("证据");
    expect(screen.getByTestId("specialist-evidence-fact_check-0-0").textContent).toContain(
      "文内对照",
    );
    expect(screen.getByTestId("specialist-evidence-fact_check-0-1").textContent).toContain(
      "检索来源",
    );
    expect(
      screen.getByTestId("specialist-evidence-fact_check-0-1").querySelector("a")?.getAttribute(
        "href",
      ),
    ).toBe("https://example.invalid/edu");
    expect(screen.getByTestId("specialist-evidence-news_edit-0-0").textContent).toContain(
      "模型判断",
    );
    expect(text).toContain("派发 2 / 2");
    expect(text).toContain("目标模型 deepseek-v4-flash");
    expect(screen.queryByTestId("specialist-verify-0")).toBeNull();
  });
});

describe("specialist orchestration panel: timeout, failure, disagreement", () => {
  test("timeout shows 调用超时 and the human-verify reason", () => {
    const run = enabledRun({
      dispatched: ["fact_check", "news_edit"],
      results: [
        result({ specialist: "fact_check", status: "timed_out", candidates: [] }),
        result({
          specialist: "news_edit",
          status: "succeeded",
          candidates: [citationCandidate()],
        }),
      ],
      judgments: [
        judgment({
          quoted_text: PERSON_QUOTE,
          decision: "verify",
          reason: TIMEOUT_REASON,
          specialist_ids: ["fact_check"],
          requires_verification: true,
        }),
        judgment({
          quoted_text: CITATION_QUOTE,
          decision: "verify",
          reason: PARTIAL_FAILURE_REASON,
          specialist_ids: ["fact_check", "news_edit"],
          requires_verification: true,
        }),
      ],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("调用超时");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("已返回");
    expect(text).toContain("待人工核实");
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain(TIMEOUT_REASON);
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain(PERSON_QUOTE);
    expect(screen.getByTestId("specialist-verify-1").textContent).toContain(PARTIAL_FAILURE_REASON);
    expect(hasPendingSpecialistVerification(run)).toBe(true);
  });

  test("failure shows 调用失败 and does not look like a clean bill", () => {
    const run = enabledRun({
      dispatched: ["fact_check"],
      results: [result({ specialist: "fact_check", status: "failed", candidates: [] })],
      judgments: [
        judgment({
          quoted_text: PERSON_QUOTE,
          decision: "verify",
          reason: FAILURE_REASON,
          specialist_ids: ["fact_check"],
          requires_verification: true,
        }),
      ],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("调用失败");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain(FAILURE_REASON);
    expect(text).not.toContain("没有问题");
    expect(text).not.toContain("未发现");
  });

  test("disagreement keeps both candidate opinions and the verify reason", () => {
    const run = enabledRun({
      dispatched: ["fact_check", "news_edit"],
      results: [
        result({
          specialist: "fact_check",
          status: "succeeded",
          candidates: [citationCandidate()],
        }),
        result({
          specialist: "news_edit",
          status: "succeeded",
          candidates: [
            citationCandidate({
              title: "保留原文并核实",
              suggestion: { text: "保留原文并核实", replacement: null },
            }),
          ],
        }),
      ],
      judgments: [
        judgment({
          quoted_text: CITATION_QUOTE,
          decision: "verify",
          reason: DISAGREEMENT_REASON,
          specialist_ids: ["fact_check", "news_edit"],
          requires_verification: true,
        }),
      ],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-candidate-fact_check-0").textContent).toContain(
      "王海涛在总结时强调开学工作",
    );
    expect(screen.getByTestId("specialist-candidate-news_edit-0").textContent).toContain(
      "无安全自动替换，需人工核实",
    );
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain(DISAGREEMENT_REASON);
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain("事实核验");
    expect(screen.getByTestId("specialist-verify-0").textContent).toContain("新闻编辑");
    expect(text).toContain(CITATION_QUOTE);
  });
});

describe("specialist orchestration panel: skipped and not dispatched", () => {
  test("budget skip stays 未调用 and shows why it was not dispatched", () => {
    const run = enabledRun({
      dispatched: ["fact_check"],
      skipped: [{ specialist: "news_edit", reason: "call budget" }],
      budget: { max_specialists: 1, used: 1 },
      results: [
        result({
          specialist: "fact_check",
          status: "succeeded",
          candidates: [personCandidate()],
        }),
      ],
      judgments: [],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("已返回");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain(
      "超出调用预算，未派发",
    );
    expect(screen.getByTestId("specialist-call-news_edit").getAttribute("data-invoked")).toBe(
      "false",
    );
    expect(text).not.toContain("已调用");
  });

  test("enabled but not dispatched does not look like the models ran", () => {
    const run = enabledRun({
      dispatched: [],
      results: [],
      judgments: [],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-orchestration-enabled").textContent).toBe("已启用");
    expect(text).toContain(SPECIALIST_ENABLED_NOT_DISPATCHED_MESSAGE);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("未调用");
    expect(screen.getByTestId("specialist-call-news_edit").textContent).toContain("未调用");
    expect(text).not.toContain("已返回");
    expect(text).not.toContain("目标模型");
    expect(text).not.toContain("没有问题");
    expect(screen.queryByTestId("specialist-empty-candidates")).toBeNull();
  });

  test("invoked success with no candidates is not presented as 没有问题", () => {
    const run = enabledRun({
      dispatched: ["fact_check"],
      results: [result({ specialist: "fact_check", status: "succeeded", candidates: [] })],
      judgments: [],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-empty-candidates").textContent).toBe(
      SPECIALIST_EMPTY_CANDIDATES_MESSAGE,
    );
    expect(text).toContain("不表示稿件没有问题");
    expect(text).not.toContain("未发现需要提示的问题");
  });

  test("explicit not_invoked provenance still reads as 未调用", () => {
    const run = enabledRun({
      dispatched: ["fact_check"],
      results: [
        result({
          specialist: "fact_check",
          status: "not_invoked",
          invoked: false,
          candidates: [personCandidate()],
        }),
      ],
      judgments: [],
    });
    const text = panelText(run);
    expect(screen.getByTestId("specialist-call-fact_check").textContent).toContain("未调用");
    expect(screen.queryByTestId("specialist-candidate-fact_check-0")).toBeNull();
    expect(text).not.toContain("职务待核验");
  });
});

describe("specialist orchestration panel: mobile readability", () => {
  test("long quotes stay in full and the stylesheet stacks fields on a phone", () => {
    const longQuote = `${PERSON_QUOTE}，并在全市基础教育高质量发展座谈会上作了较长的工作部署说明。`;
    const run = enabledRun({
      dispatched: ["fact_check"],
      results: [
        result({
          specialist: "fact_check",
          status: "succeeded",
          candidates: [personCandidate({ source: {
            field: "body",
            exact_quote: longQuote,
            paragraph_index: 0,
            context_before: "会议开始后，",
            context_after: "与会人员进行了讨论。",
          } })],
        }),
      ],
      judgments: [],
    });
    render(<SpecialistOrchestrationPanel run={run} />);
    expect(screen.getByTestId("specialist-fragment-0").textContent).toContain(longQuote);
    expect(screen.getByTestId("specialist-candidate-fact_check-0").textContent).toContain(longQuote);
    expect(screen.getByTestId("specialist-orchestration-panel").className).toContain(
      "specialist-orchestration-panel",
    );

    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../apps/web/src/app/globals.css"),
      "utf8",
    );
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*\.specialist-field\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width: 1023px\)[\s\S]*\.specialist-call-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toContain("overflow-wrap: anywhere");
  });
});

describe("specialist orchestration panel: isolation", () => {
  test("UI source does not import agent-orchestration, review-core, or the reviews API", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const panel = readFileSync(
      join(root, "apps/web/src/components/review/SpecialistOrchestrationPanel.tsx"),
      "utf8",
    );
    const view = readFileSync(
      join(root, "apps/web/src/components/review/specialist-orchestration-view.ts"),
      "utf8",
    );
    for (const source of [panel, view]) {
      expect(source).not.toContain("@grc/agent-orchestration");
      expect(source).not.toContain("@grc/review-core");
      expect(source).not.toContain("/api/reviews");
    }
  });
});
