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
  DEFAULT_MODEL_SPECIALIST_DEADLINE_MS,
  DEFAULT_SPECIALIST_MAX_CANDIDATES,
  FACT_CHECK_FINDING_TYPES,
  FakeFactCheckSpecialist,
  FakeNewsEditSpecialist,
  NEWS_EDIT_FINDING_TYPES,
  SPECIALIST_DISAGREEMENT_MESSAGE,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_MAX_ATTEMPTS,
  SPECIALIST_MAX_TOKENS,
  SPECIALIST_PARTIAL_FAILURE_MESSAGE,
  SPECIALIST_REQUEST_TIMEOUT_MS,
  SPECIALIST_ROLE_PROMPTS,
  SPECIALIST_ROLE_TITLES,
  SPECIALIST_SDK_MAX_RETRIES,
  SPECIALIST_TARGET_MODEL,
  SPECIALIST_TIMEOUT_MESSAGE,
  createFakeSpecialists,
  createModelSpecialists,
  createSpecialistOrchestrator,
  createSpecialistOrchestratorFromEnv,
  createSpecialistRuntime,
  createSpecialistRuntimeFromEnv,
  extractFragments,
  isSpecialistOrchestrationEnabled,
  selectSpecialists,
  specialistIdsForFindings,
  specialistTaskContainsFullArticle,
  webEvidenceForFragments,
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
  test("stays off by default and is not wired into createReview without a runtime", async () => {
    expect(isSpecialistOrchestrationEnabled()).toBe(false);
    expect(createSpecialistOrchestratorFromEnv()).toBeNull();
    expect(createSpecialistRuntimeFromEnv()).toBeNull();

    process.env.REVIEW_SPECIALISTS_ENABLED = "1";
    expect(createSpecialistRuntimeFromEnv()).toBeNull();
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
        run(task, options) {
          seen.push(task);
          return fact.run(task, options);
        },
      },
      {
        id: "news_edit",
        run(task, options) {
          seen.push(task);
          return news.run(task, options);
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

  test("web evidence is filtered to the current specialist fragments, not broadcast", async () => {
    const seen: SpecialistTask[] = [];
    const fact = new FakeFactCheckSpecialist();
    const news = new FakeNewsEditSpecialist();
    const recording: Specialist[] = [
      {
        id: "fact_check",
        run(task, options) {
          seen.push(task);
          return fact.run(task, options);
        },
      },
      {
        id: "news_edit",
        run(task, options) {
          seen.push(task);
          return news.run(task, options);
        },
      },
    ];
    const personWeb = {
      source_name: "教育部",
      url: "https://example.invalid/edu",
      excerpt: "市教育局局长王海涛",
      title: "市教育局局长王海涛",
      source_tier: "official" as const,
      published_or_version_date: "2026-01-01",
    };
    const statsWeb = {
      source_name: "统计公报",
      url: "https://example.invalid/stats",
      excerpt: "义务教育阶段在校生共128万人",
      title: "在校生统计",
      source_tier: "official" as const,
      published_or_version_date: "2026-01-01",
    };
    const personFragments = extractFragments(article, [personFinding]);
    expect(webEvidenceForFragments(personFragments, [personFinding], [personWeb, statsWeb])).toEqual([
      personWeb,
    ]);

    await createSpecialistOrchestrator(recording, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, typoFinding, consistencyFinding],
      retrievedEvidence,
      webEvidence: [personWeb, statsWeb],
    });

    const factTask = seen.find((task) => task.specialist === "fact_check");
    const newsTask = seen.find((task) => task.specialist === "news_edit");
    expect(factTask?.webEvidence.map((item) => item.url)).toEqual(["https://example.invalid/edu"]);
    expect(newsTask?.webEvidence.map((item) => item.url)).toEqual(["https://example.invalid/stats"]);
    expect(factTask?.webEvidence.some((item) => item.url === "https://example.invalid/stats")).toBe(
      false,
    );
    expect(newsTask?.webEvidence.some((item) => item.url === "https://example.invalid/edu")).toBe(
      false,
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
    expect(pipeline).toContain("specialistRuntime");
  });
});

describe("DeepSeek specialist adapter", () => {
  test("model specialists send fragments and evidence, never the full article", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      async completeJson(input) {
        calls.push(input);
        return [];
      },
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, typoFinding, consistencyFinding],
      retrievedEvidence,
    });

    expect(run.dispatched).toEqual(["fact_check", "news_edit"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((item) => item.system.includes("不要用多数票") || item.system.includes("新闻编辑专家"))).toBe(
      true,
    );
    expect(JSON.stringify(calls).includes("SECRET_FULL_TEXT_MARKER")).toBe(false);
    expect(JSON.stringify(calls).includes(article.body)).toBe(false);
    expect(calls.some((item) => item.user.includes("市教育局局长王海涛"))).toBe(true);
    expect(calls.some((item) => item.user.includes("source-edu-bureau"))).toBe(true);
    expect(calls.every((item) => !item.user.includes("type=basic_text"))).toBe(true);
    expect(run.results.every((item) => item.provenance.provider === "deepseek")).toBe(true);
    expect(run.results.every((item) => item.provenance.model === "deepseek-v4-flash")).toBe(true);
  });

  test("model specialists copy observed model and usage from the completion client", async () => {
    let calls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve([]),
      consumeLastProvenance() {
        calls += 1;
        return {
          adapter_provider: "deepseek",
          requested_model: "deepseek-v4-flash",
          observed_response_model: "deepseek-v4-flash",
          observed_response_model_status: "observed",
          attempt_count: 1,
          attempts: [],
          aggregated_usage: {
            input_tokens: 90 + calls,
            input_tokens_completeness: "complete",
            output_tokens: 20,
            output_tokens_completeness: "complete",
            cached_input_tokens: 0,
            cached_input_tokens_status: "reported",
            cached_input_tokens_completeness: "complete",
            unobserved_usage_attempts: 0,
          },
          application_cache: { enabled: false, hit: false },
          latency_ms: 100,
        };
      },
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
    });

    expect(calls).toBe(2);
    expect(
      run.results.every(
        (item) =>
          item.provenance.trace_status === "observed" &&
          item.provenance.observed_response_model === "deepseek-v4-flash" &&
          item.provenance.attempt_count === 1 &&
          item.provenance.aggregated_usage.output_tokens === 20,
      ),
    ).toBe(true);
    const inputTokens = run.results.map((item) => item.provenance.aggregated_usage.input_tokens);
    expect(new Set(inputTokens).size).toBe(2);
  });

  test("failed specialist calls keep attempts and usage for cost audit", async () => {
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.reject(new Error("malformed JSON")),
      consumeLastProvenance() {
        return {
          adapter_provider: "deepseek",
          requested_model: "deepseek-v4-flash",
          observed_response_model: "deepseek-v4-flash",
          observed_response_model_status: "observed",
          attempt_count: 1,
          attempts: [
            {
              attempt: 1,
              outcome: "retryable_failure",
              requested_model: "deepseek-v4-flash",
              observed_response_model: "deepseek-v4-flash",
              received_provider_response: true,
              usage: {
                input_tokens: 80,
                output_tokens: 12,
                cached_input_tokens: 0,
                cached_input_tokens_status: "reported",
              },
              error: "malformed JSON",
            },
          ],
          aggregated_usage: {
            input_tokens: 80,
            input_tokens_completeness: "complete",
            output_tokens: 12,
            output_tokens_completeness: "complete",
            cached_input_tokens: 0,
            cached_input_tokens_status: "reported",
            cached_input_tokens_completeness: "complete",
            unobserved_usage_attempts: 0,
          },
          application_cache: { enabled: false, hit: false },
          latency_ms: 40,
        };
      },
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.provenance.status).toBe("failed");
    expect(fact?.provenance.trace_status).toBe("observed");
    expect(fact?.provenance.attempts).toHaveLength(1);
    expect(fact?.provenance.attempts[0]?.usage?.input_tokens).toBe(80);
    expect(fact?.provenance.aggregated_usage.input_tokens_completeness).toBe("complete");
  });

  test("unobserved specialist failures are labeled unobserved instead of guessed", async () => {
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.reject(new Error("boom")),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.provenance.status).toBe("failed");
    expect(fact?.provenance.trace_status).toBe("unobserved");
    expect(fact?.provenance.observed_response_model).toBeNull();
    expect(fact?.provenance.attempts).toEqual([]);
    expect(fact?.provenance.aggregated_usage.input_tokens_completeness).toBe("not_observed");
    expect(fact?.provenance.aggregated_usage.unobserved_usage_attempts).toBe(1);
  });

  test("a pre-aborted parent does not invoke specialists", async () => {
    let calls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        calls += 1;
        return Promise.resolve([]);
      },
    }));
    const controller = new AbortController();
    controller.abort();
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
      signal: controller.signal,
    });
    expect(calls).toBe(0);
    expect(run.dispatched).toEqual([]);
    expect(run.budget.used).toBe(0);
    expect(run.skipped.every((item) => item.reason === "deadline")).toBe(true);
    expect(
      run.results.every(
        (item) =>
          item.provenance.invoked === false &&
          item.provenance.status === "not_invoked" &&
          item.provenance.attempt_count === 0,
      ),
    ).toBe(true);
  });

  test("a specialist that ignores abort still returns when the deadline fires", async () => {
    let calls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        calls += 1;
        return new Promise(() => undefined);
      },
    }));
    const started = Date.now();
    const run = await createSpecialistOrchestrator(specialists, { deadlineMs: 40 }).orchestrate({
      article,
      findings: [personFinding],
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(1);
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.provenance.invoked).toBe(true);
    expect(fact?.provenance.status).toBe("timed_out");
  });

  test("drops basic_text and quotes that are not in the current task fragments", async () => {
    const mixed: ReviewCandidate[] = [
      candidateOn("座谈谈会", "错别字", "座谈会"),
      {
        ...candidateOn("SECRET_FULL_TEXT_MARKER", "编造全文片段", null),
        type: "person",
      },
      {
        ...candidateOn("市教育局局长王海涛", "职务待核验", null),
        type: "person",
      },
      {
        ...candidateOn("义务教育阶段在校生共128万人", "文内数字前后矛盾", null),
        type: "consistency",
      },
    ];
    mixed[0] = { ...mixed[0]!, type: "basic_text", severity: "low" };
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve(mixed),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding, typoFinding, consistencyFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    const news = run.results.find((item) => item.provenance.specialist === "news_edit");
    expect(fact?.candidates.map((item) => item.type)).toEqual(["person"]);
    expect(fact?.candidates.map((item) => item.source.exact_quote)).toEqual(["市教育局局长王海涛"]);
    expect(news?.candidates.map((item) => item.type)).toEqual(["consistency"]);
    expect(news?.candidates.map((item) => item.source.exact_quote)).toEqual([
      "义务教育阶段在校生共128万人",
    ]);
    expect(fact?.candidates.every((item) => item.type !== "basic_text")).toBe(true);
    expect(news?.candidates.every((item) => item.type !== "basic_text")).toBe(true);
    expect(
      [...(fact?.candidates ?? []), ...(news?.candidates ?? [])].every(
        (item) => item.source.exact_quote !== "座谈谈会",
      ),
    ).toBe(true);
    expect(JSON.stringify(run.results).includes("SECRET_FULL_TEXT_MARKER")).toBe(false);
  });

  test("keeps only retrieved_source and source_url that were supplied on the task", async () => {
    const mixed: ReviewCandidate[] = [
      {
        ...candidateOn("市教育局局长王海涛", "职务待核验", null),
        type: "person",
        source_id: "invented-id",
        evidence: [
          {
            kind: "retrieved_source",
            excerpt: "市教育局局长王海涛",
            citation_validated: false,
            source_id: "source-edu-bureau",
            source_url: "https://example.invalid/edu",
          },
          {
            kind: "retrieved_source",
            excerpt: "forged dossier",
            citation_validated: false,
            source_id: "invented-id",
            source_url: "https://evil.example/fake",
          },
          {
            kind: "ai_judgment",
            excerpt: "模型判断",
            citation_validated: false,
            source_url: "https://evil.example/fake",
          },
          {
            kind: "retrieved_source",
            excerpt: "市教育局局长王海涛",
            citation_validated: false,
            source_url: "https://example.invalid/web-person",
          },
        ],
      },
    ];
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve(mixed),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
      retrievedEvidence,
      webEvidence: [
        {
          source_name: "教育部",
          url: "https://example.invalid/web-person",
          excerpt: "市教育局局长王海涛",
          title: "市教育局局长王海涛",
          source_tier: "official",
          published_or_version_date: "2026-01-01",
        },
      ],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    const packed = JSON.stringify(fact?.candidates);
    expect(fact?.candidates).toHaveLength(1);
    expect(fact?.candidates[0]?.source_id).toBeUndefined();
    expect(fact?.candidates[0]?.evidence).toEqual([
      {
        kind: "retrieved_source",
        excerpt: "市教育局局长王海涛",
        citation_validated: false,
        source_id: "source-edu-bureau",
        source_url: "https://example.invalid/edu",
      },
      {
        kind: "ai_judgment",
        excerpt: "模型判断",
        citation_validated: false,
      },
      {
        kind: "retrieved_source",
        excerpt: "市教育局局长王海涛",
        citation_validated: false,
        source_url: "https://example.invalid/web-person",
      },
    ]);
    expect(packed.includes("invented-id")).toBe(false);
    expect(packed.includes("evil.example")).toBe(false);
  });

  test("drops candidates whose paragraph_index does not match the task fragment", async () => {
    const wrongParagraph: ReviewCandidate = {
      ...candidateOn("市教育局局长王海涛", "职务待核验", null),
      type: "person",
      source: {
        ...candidateOn("市教育局局长王海涛", "职务待核验", null).source,
        paragraph_index: 9,
      },
    };
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve([wrongParagraph]),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.candidates).toEqual([]);
  });

  test("overwrites model-generated context with the matching fragment context", async () => {
    const forged: ReviewCandidate = {
      ...candidateOn("市教育局局长王海涛", "职务待核验", null),
      type: "person",
      source: {
        field: "body",
        exact_quote: "市教育局局长王海涛",
        paragraph_index: 0,
        context_before: "FORGED_CONTEXT_BEFORE",
        context_after: "FORGED_CONTEXT_AFTER",
      },
    };
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve([forged]),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const expected = extractFragments(article, [personFinding])[0];
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.candidates).toHaveLength(1);
    expect(fact?.candidates[0]?.source).toEqual({
      field: expected?.field,
      exact_quote: "市教育局局长王海涛",
      paragraph_index: expected?.paragraph_index,
      context_before: expected?.context_before,
      context_after: expected?.context_after,
    });
    expect(JSON.stringify(fact?.candidates).includes("FORGED_CONTEXT_BEFORE")).toBe(false);
    expect(JSON.stringify(fact?.candidates).includes("FORGED_CONTEXT_AFTER")).toBe(false);
  });

  test("downgrades forged rule evidence to ai_judgment", async () => {
    const mixed: ReviewCandidate[] = [
      {
        ...candidateOn("市教育局局长王海涛", "职务待核验", null),
        type: "person",
        rule_id: "invented-rule",
        evidence: [
          {
            kind: "rule",
            excerpt: "职务表述须核验",
            citation_validated: true,
            rule_id: "invented-rule",
          },
        ],
      },
    ];
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve(mixed),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.candidates[0]?.rule_id).toBeUndefined();
    expect(fact?.candidates[0]?.evidence).toEqual([
      {
        kind: "ai_judgment",
        excerpt: "职务表述须核验",
        citation_validated: false,
      },
    ]);
    expect(JSON.stringify(fact?.candidates).includes("invented-rule")).toBe(false);
    expect(JSON.stringify(fact?.candidates).includes('"kind":"rule"')).toBe(false);
  });

  test("downgrades internal_context that is not in the task fragments", async () => {
    const mixed: ReviewCandidate[] = [
      {
        ...candidateOn("市教育局局长王海涛", "职务待核验", null),
        type: "person",
        evidence: [
          {
            kind: "internal_context",
            excerpt: "市教育局局长王海涛",
            citation_validated: true,
          },
          {
            kind: "internal_context",
            excerpt: "SECRET_FULL_TEXT_MARKER",
            citation_validated: true,
          },
        ],
      },
    ];
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson: () => Promise.resolve(mixed),
    }));
    const run = await createSpecialistOrchestrator(specialists, { nowMs: () => 0 }).orchestrate({
      article,
      findings: [personFinding],
    });
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.candidates[0]?.evidence).toEqual([
      {
        kind: "internal_context",
        excerpt: "市教育局局长王海涛",
        citation_validated: true,
      },
      {
        kind: "ai_judgment",
        excerpt: "SECRET_FULL_TEXT_MARKER",
        citation_validated: false,
      },
    ]);
  });

  test("model specialists use a single attempt, 12s request timeout, 15s deadline, and a smaller candidate budget", async () => {
    const calls: Array<{
      maxTokens?: number;
      maxAttempts?: number;
      maxRetries?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    }> = [];
    const tasks: SpecialistTask[] = [];
    const inner = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      async completeJson(input) {
        calls.push(input);
        return [];
      },
    }));
    const specialists: Specialist[] = inner.map((specialist) => ({
      id: specialist.id,
      provider: specialist.provider,
      model: specialist.model,
      run(task, options) {
        tasks.push(task);
        return specialist.run(task, options);
      },
    }));
    const run = await createSpecialistRuntime(specialists).orchestrate({
      article,
      findings: [personFinding, consistencyFinding],
    });

    expect(DEFAULT_MODEL_SPECIALIST_DEADLINE_MS).toBe(15_000);
    expect(SPECIALIST_REQUEST_TIMEOUT_MS).toBe(12_000);
    expect(DEFAULT_SPECIALIST_MAX_CANDIDATES).toBe(3);
    expect(SPECIALIST_MAX_TOKENS).toBe(2048);
    expect(SPECIALIST_MAX_ATTEMPTS).toBe(1);
    expect(SPECIALIST_SDK_MAX_RETRIES).toBe(0);
    expect(run.dispatched).toEqual(["fact_check", "news_edit"]);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.constraints.deadlineMs === 15_000)).toBe(true);
    expect(tasks.every((task) => task.constraints.maxCandidates === 3)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (item) =>
          item.maxAttempts === 1 &&
          item.maxRetries === 0 &&
          item.maxTokens === 2048 &&
          item.timeoutMs === 12_000 &&
          item.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  test("orchestration deadline aborts the specialist HTTP request and degrades to 待人工核实", async () => {
    let aborted = false;
    let createCalls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson(input) {
        createCalls += 1;
        return new Promise<never>((_, reject) => {
          const signal = input.signal;
          if (signal?.aborted) {
            aborted = true;
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    }));
    const run = await createSpecialistOrchestrator(specialists, { deadlineMs: 30 }).orchestrate({
      article,
      findings: [personFinding],
    });

    expect(aborted).toBe(true);
    expect(createCalls).toBe(1);
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.provenance.status).toBe("timed_out");
    expect(fact?.candidates).toEqual([]);
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

  test("a retryable specialist provider failure is not retried and still degrades to 待人工核实", async () => {
    let createCalls = 0;
    const specialists = createModelSpecialists(() => ({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      completeJson() {
        createCalls += 1;
        return Promise.reject(new Error("malformed JSON"));
      },
    }));
    const run = await createSpecialistRuntime(specialists).orchestrate({
      article,
      findings: [personFinding],
    });

    expect(createCalls).toBe(1);
    const fact = run.results.find((item) => item.provenance.specialist === "fact_check");
    expect(fact?.provenance.status).toBe("failed");
    expect(fact?.candidates).toEqual([]);
    expect(
      run.judgments.some(
        (item) =>
          item.decision === "verify" &&
          item.requires_verification &&
          item.reason === SPECIALIST_FAILURE_MESSAGE,
      ),
    ).toBe(true);
  });
});
