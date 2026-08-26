import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type {
  CanonicalArticle,
  ReviewCandidate,
  Specialist,
  SpecialistPreliminaryFinding,
  SpecialistTask,
} from "@grc/contracts";
import {
  MODEL_SPECIALIST_IDS,
  SPECIALIST_MAX_PER_ARTICLE,
  parseSpecialistResult,
  specialistOrchestrationRunSchema,
  specialistTaskSchema,
} from "@grc/contracts";
import { FixtureReviewModel } from "@grc/providers";
import { createReview } from "@grc/review-core";
import {
  FACT_CHECK_FINDING_TYPES,
  FakeFactCheckSpecialist,
  FakeNewsEditSpecialist,
  NEWS_EDIT_FINDING_TYPES,
  SPECIALIST_DISAGREEMENT_MESSAGE,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_PARTIAL_FAILURE_MESSAGE,
  SPECIALIST_ROLE_PROMPTS,
  SPECIALIST_ROLE_TITLES,
  SPECIALIST_TARGET_MODEL,
  SPECIALIST_TIMEOUT_MESSAGE,
  createFakeSpecialists,
  createSpecialistOrchestrator,
  createSpecialistOrchestratorFromEnv,
  extractFragments,
  isSpecialistOrchestrationEnabled,
  selectSpecialists,
  specialistIdsForFindings,
  specialistTaskContainsFullArticle,
} from "@grc/agent-orchestration";

const article: CanonicalArticle = {
  title: "我市召开基础教育高质量发展座谈会",
  body: "上周四（8月12日）召开座谈谈会。市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。本次座谈会由市教育委员会主办。要学习《教育强国建设规划纲要（2023－2035年）》。王强在总结时强调开学工作。另据通报义务教育阶段在校生共182万人。SECRET_FULL_TEXT_MARKER。",
  version: 1,
};

function spanFor(quoted: string) {
  const start = article.body.indexOf(quoted);
  if (start < 0) {
    throw new Error(`quote not found: ${quoted}`);
  }
  return {
    field: "body" as const,
    start_offset: start,
    end_offset: start + quoted.length,
    quoted_text: quoted,
    paragraph_index: 0,
    article_version: 1,
  };
}

function finding(
  type: SpecialistPreliminaryFinding["type"],
  quoted: string,
  title: string,
  extras: Partial<SpecialistPreliminaryFinding> = {},
): SpecialistPreliminaryFinding {
  return {
    type,
    severity: type === "basic_text" ? "low" : "high",
    title,
    reason: `${title}：${quoted}`,
    source_span: spanFor(quoted),
    suggestion: { text: title, replacement: null },
    confidence: 0.7,
    ...extras,
  };
}

const personFinding = finding("person", "市教育局局长王海涛", "职务待核验");
const typoFinding = finding("basic_text", "座谈谈会", "疑似错别字");
const consistencyFinding = finding(
  "consistency",
  "义务教育阶段在校生共128万人",
  "文内数字前后矛盾",
);
const citationFinding = finding("citation", "王强在总结时强调开学工作", "引语归属待核验");

const retrievedEvidence = [
  {
    source_id: "source-edu-bureau",
    source_name: "权威名录",
    source_url: "https://example.invalid/edu",
    authority_level: "official" as const,
    published_at: "2026-01-01",
    valid_from: "2026-01-01",
    valid_to: null,
    excerpt: "市教育局局长王海涛",
    match_rank: 410,
    trigger: "市教育局局长王海涛",
  },
];

function candidateOn(
  quoted: string,
  title: string,
  replacement: string | null,
): ReviewCandidate {
  const span = spanFor(quoted);
  return {
    type: "citation",
    severity: "high",
    title,
    reason: title,
    suggestion: { text: title, replacement },
    confidence: 0.6,
    evidence: [{ kind: "ai_judgment", excerpt: span.quoted_text, citation_validated: true }],
    source: {
      field: span.field,
      exact_quote: span.quoted_text,
      paragraph_index: span.paragraph_index,
      context_before: null,
      context_after: null,
    },
  };
}

describe("agent orchestration foundation", () => {
  test("stays off by default and is not wired into createReview", async () => {
    expect(isSpecialistOrchestrationEnabled()).toBe(false);
    expect(createSpecialistOrchestratorFromEnv()).toBeNull();

    process.env.REVIEW_SPECIALISTS_ENABLED = "1";
    const model = new FixtureReviewModel([]);
    const result = await createReview(
      { title: article.title, body: article.body },
      model,
    );
    delete process.env.REVIEW_SPECIALISTS_ENABLED;

    expect(result.pipeline.specialists_enabled).toBe(false);
    expect(result.pipeline).not.toHaveProperty("specialist_orchestration");
  });

  test("roles are fact-check and news-edit perspectives, not the rules engine", () => {
    expect(MODEL_SPECIALIST_IDS).toEqual(["fact_check", "news_edit"]);
    expect(SPECIALIST_ROLE_TITLES.fact_check).toBe("事实核验专家");
    expect(SPECIALIST_ROLE_TITLES.news_edit).toBe("新闻编辑专家");
    expect(SPECIALIST_TARGET_MODEL).toBe("deepseek-v4-flash");
    expect(SPECIALIST_ROLE_PROMPTS.fact_check).toContain("事实核验专家");
    expect(SPECIALIST_ROLE_PROMPTS.news_edit).toContain("新闻编辑专家");
    expect(SPECIALIST_ROLE_PROMPTS.fact_check).toContain("不要用多数票");
    expect(FACT_CHECK_FINDING_TYPES).not.toContain("basic_text");
    expect(NEWS_EDIT_FINDING_TYPES).toEqual(["consistency", "citation"]);
    expect(NEWS_EDIT_FINDING_TYPES).not.toContain("basic_text");
    expect(specialistIdsForFindings([{ type: "basic_text" }])).toEqual([]);
    expect(specialistIdsForFindings([{ type: "person" }, { type: "basic_text" }])).toEqual([
      "fact_check",
    ]);
    expect(specialistIdsForFindings([{ type: "consistency" }])).toEqual(["news_edit"]);
    expect(specialistIdsForFindings([{ type: "person" }, { type: "consistency" }])).toEqual([
      "fact_check",
      "news_edit",
    ]);
    expect(createFakeSpecialists().map((item) => item.id)).toEqual(["fact_check", "news_edit"]);
  });

  test("basic_text findings do not dispatch a model specialist", async () => {
    const run = await createSpecialistOrchestrator(createFakeSpecialists(), { nowMs: () => 0 }).orchestrate({
      article,
      findings: [typoFinding],
    });
    expect(run.dispatched).toEqual([]);
    expect(run.budget).toEqual({ max_specialists: SPECIALIST_MAX_PER_ARTICLE, used: 0 });
    expect(run.results).toEqual([]);
    expect(run.judgments).toEqual([]);
  });

  test("dispatches at most two specialists and does not send the full article", async () => {
    const seen: SpecialistTask[] = [];
    const fact = new FakeFactCheckSpecialist();
    const news = new FakeNewsEditSpecialist();
    const recording: Specialist[] = [
      {
        id: "fact_check",
        run(task) {
          seen.push(task);
          return fact.run(task);
        },
      },
      {
        id: "news_edit",
        run(task) {
          seen.push(task);
          return news.run(task);
        },
      },
    ];
    const orchestrator = createSpecialistOrchestrator(recording, { nowMs: () => 0 });
    const run = await orchestrator.orchestrate({
      article,
      findings: [personFinding, typoFinding, consistencyFinding, citationFinding],
      retrievedEvidence,
    });

    expect(run.enabled).toBe(true);
    expect(run.target_model).toBe("deepseek-v4-flash");
    expect(run.dispatched).toEqual(["fact_check", "news_edit"]);
    expect(run.budget).toEqual({ max_specialists: SPECIALIST_MAX_PER_ARTICLE, used: 2 });
    expect(seen).toHaveLength(2);
    expect(seen.every((task) => task.article === undefined)).toBe(true);
    expect(seen.every((task) => task.constraints.allowExternalRetrieval === false)).toBe(true);
    expect(seen.every((task) => !specialistTaskContainsFullArticle(task, article))).toBe(true);
    expect(JSON.stringify(seen).includes("SECRET_FULL_TEXT_MARKER")).toBe(false);
    expect(seen.every((task) => specialistTaskSchema.parse(task).fragments.length > 0)).toBe(true);

    const factTask = seen.find((task) => task.specialist === "fact_check");
    const newsTask = seen.find((task) => task.specialist === "news_edit");
    expect(factTask?.preliminaryFindings.every((item) => item.type !== "basic_text")).toBe(true);
    expect(newsTask?.preliminaryFindings.every((item) => item.type !== "basic_text")).toBe(true);
    expect(newsTask?.preliminaryFindings.every((item) => item.type !== "person")).toBe(true);
    expect(newsTask?.preliminaryFindings.some((item) => item.type === "consistency")).toBe(true);
    expect(factTask?.retrievedEvidence.map((item) => item.source_id)).toEqual(["source-edu-bureau"]);
    expect(newsTask?.retrievedEvidence).toEqual([]);
    expect(run.results.every((item) => item.provenance.provider === "fixture")).toBe(true);
    expect(run.results.every((item) => item.provenance.model === "fake-specialist")).toBe(true);
  });

  test("caps the call budget and records skipped specialists", async () => {
    const orchestrator = createSpecialistOrchestrator(createFakeSpecialists(), {
      maxSpecialists: 1,
      nowMs: () => 0,
    });
    const run = await orchestrator.orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
    });
    expect(run.dispatched).toEqual(["fact_check"]);
    expect(run.skipped).toEqual([{ specialist: "news_edit", reason: "call budget" }]);
    expect(run.budget).toEqual({ max_specialists: 1, used: 1 });
    expect(run.warnings.some((item) => item.includes("news_edit skipped: call budget"))).toBe(true);
  });

  test("cannot exceed two specialists even if a higher budget is requested", () => {
    expect(
      selectSpecialists({
        findings: [personFinding, consistencyFinding],
        available: ["fact_check", "news_edit", "entity", "policy"],
        maxSpecialists: 8,
      }).dispatched,
    ).toEqual(["fact_check", "news_edit"]);
  });

  test("runs specialists in parallel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;

    const latch = (id: "fact_check" | "news_edit"): Specialist => ({
      id,
      async run(task) {
        started += 1;
        if (started === 2) {
          release();
        }
        await gate;
        return parseSpecialistResult({
          taskId: task.taskId,
          candidates: [],
          provenance: {
            taskId: task.taskId,
            specialist: id,
            invoked: true,
            status: "succeeded",
            provider: "fixture",
            model: "fake-specialist",
            elapsedMs: 0,
          },
          warnings: [],
        });
      },
    });

    const run = await createSpecialistOrchestrator([latch("fact_check"), latch("news_edit")], {
      deadlineMs: 500,
      nowMs: () => 0,
    }).orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
    });

    expect(run.results.map((item) => item.provenance.status)).toEqual(["succeeded", "succeeded"]);
  });

  test("times out a hung specialist and degrades to 待人工核实", async () => {
    const run = await createSpecialistOrchestrator(
      [new FakeFactCheckSpecialist({ behavior: "timeout" }), new FakeNewsEditSpecialist()],
      { deadlineMs: 30 },
    ).orchestrate({
      article,
      findings: [personFinding, consistencyFinding, citationFinding],
    });

    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    const news = run.results.find((item) => item.provenance.specialist === "news_edit");
    expect(fact?.provenance.status).toBe("timed_out");
    expect(fact?.candidates).toEqual([]);
    expect(news?.provenance.status).toBe("succeeded");
    expect(
      run.judgments.some(
        (item) =>
          item.decision === "verify" &&
          item.requires_verification &&
          (item.reason === SPECIALIST_TIMEOUT_MESSAGE ||
            item.reason === SPECIALIST_PARTIAL_FAILURE_MESSAGE),
      ),
    ).toBe(true);
  });

  test("keeps the successful specialist and degrades failed overlap to verify", async () => {
    const run = await createSpecialistOrchestrator(
      [new FakeFactCheckSpecialist({ behavior: "failure" }), new FakeNewsEditSpecialist()],
      { nowMs: () => 0 },
    ).orchestrate({
      article,
      findings: [personFinding, consistencyFinding, citationFinding],
    });

    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    const news = run.results.find((item) => item.provenance.specialist === "news_edit");
    expect(fact?.provenance.status).toBe("failed");
    expect(news?.provenance.status).toBe("succeeded");
    expect(news?.candidates.length).toBeGreaterThan(0);

    const personJudgment = run.judgments.find((item) => item.quoted_text === "市教育局局长王海涛");
    const consistencyJudgment = run.judgments.find(
      (item) => item.quoted_text === "义务教育阶段在校生共128万人",
    );
    const citationJudgment = run.judgments.find(
      (item) => item.quoted_text === "王强在总结时强调开学工作",
    );
    expect(personJudgment?.decision).toBe("verify");
    expect(personJudgment?.requires_verification).toBe(true);
    expect(personJudgment?.reason).toBe(SPECIALIST_FAILURE_MESSAGE);
    expect(consistencyJudgment?.decision).toBe("keep");
    expect(citationJudgment?.decision).toBe("verify");
    expect(citationJudgment?.reason).toBe(SPECIALIST_PARTIAL_FAILURE_MESSAGE);
  });

  test("disagreement is not resolved by majority vote", async () => {
    const quote = "王强在总结时强调开学工作";
    const run = await createSpecialistOrchestrator(
      [
        new FakeFactCheckSpecialist({
          catalog: { [quote]: candidateOn(quote, "应改为王海涛", "王海涛在总结时强调开学工作") },
        }),
        new FakeNewsEditSpecialist({
          catalog: { [quote]: candidateOn(quote, "保留原文并核实", null) },
        }),
      ],
      { nowMs: () => 0 },
    ).orchestrate({
      article,
      findings: [citationFinding],
    });

    const judgment = run.judgments.find((item) => item.quoted_text === quote);
    expect(run.dispatched).toEqual(["fact_check", "news_edit"]);
    expect(judgment).toEqual({
      field: "body",
      paragraph_index: 0,
      quoted_text: quote,
      decision: "verify",
      reason: SPECIALIST_DISAGREEMENT_MESSAGE,
      specialist_ids: ["fact_check", "news_edit"],
      requires_verification: true,
    });
    const replacements = run.results.flatMap((item) =>
      item.candidates.map((candidate) => candidate.suggestion.replacement),
    );
    expect(replacements).toEqual(["王海涛在总结时强调开学工作", null]);
  });

  test("fake specialists are deterministic", async () => {
    const orchestrator = createSpecialistOrchestrator(createFakeSpecialists(), { nowMs: () => 0 });
    const input = {
      article,
      findings: [personFinding, consistencyFinding],
      retrievedEvidence,
    };
    const first = await orchestrator.orchestrate(input);
    const second = await orchestrator.orchestrate(input);
    expect(first.results.map((item) => item.candidates)).toEqual(
      second.results.map((item) => item.candidates),
    );
    expect(first.judgments).toEqual(second.judgments);
  });

  test("fragments are sliced from the article and stay smaller than the full text", () => {
    const fragments = extractFragments(article, [personFinding, typoFinding]);
    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.every((item) => item.quoted_text.length < article.body.length)).toBe(true);
    expect(fragments.every((item) => !item.quoted_text.includes("SECRET_FULL_TEXT_MARKER"))).toBe(
      true,
    );
  });

  test("orchestration run is structured and parseable", async () => {
    const run = await createSpecialistOrchestrator(createFakeSpecialists(), { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
    });
    expect(specialistOrchestrationRunSchema.parse(run).warnings).toEqual([]);
    expect(run.results.every((item) => item.provenance.invoked)).toBe(true);
  });
});

describe("review-core isolation from specialist orchestration", () => {
  test("pipeline source does not import the orchestration package", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const pipeline = readFileSync(join(root, "packages/review-core/src/pipeline.ts"), "utf8");
    expect(pipeline).not.toContain("@grc/agent-orchestration");
    expect(pipeline).toContain("specialists_enabled: false");
  });
});
