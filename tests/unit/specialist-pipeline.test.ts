import { describe, expect, test } from "vitest";

import type {
  ReviewCandidate,
  Specialist,
  SpecialistRuntime,
  SpecialistTask,
} from "@grc/contracts";
import {
  SPECIALIST_DISAGREEMENT_MESSAGE,
  SPECIALIST_FAILURE_MESSAGE,
  SPECIALIST_MAX_PER_ARTICLE,
  SPECIALIST_TARGET_MODEL,
  WEB_EVIDENCE_RETRIEVED_MESSAGE,
} from "@grc/contracts";
import { FixtureReviewModel } from "@grc/providers";
import { createReview } from "@grc/review-core";
import {
  FakeFactCheckSpecialist,
  FakeNewsEditSpecialist,
  createFakeSpecialists,
  createSpecialistRuntime,
  createSpecialistRuntimeFromEnv,
  specialistTaskContainsFullArticle,
} from "@grc/agent-orchestration";

const article = {
  title: "我市召开基础教育高质量发展座谈会",
  body: "上周四（8月12日）召开座谈谈会。市教育局局长王海涛出席。会上通报义务教育阶段在校生共128万人。本次座谈会由市教育委员会主办。要学习《教育强国建设规划纲要（2023－2035年）》。王强在总结时强调开学工作。另据通报义务教育阶段在校生共182万人。SECRET_FULL_TEXT_MARKER。",
};

function candidate(
  type: ReviewCandidate["type"],
  quote: string,
  title: string,
  replacement: string | null = null,
): ReviewCandidate {
  return {
    type,
    severity: type === "basic_text" ? "low" : "high",
    title,
    reason: `${title}：${quote}`,
    suggestion: { text: title, replacement },
    confidence: 0.7,
    evidence: [{ kind: "ai_judgment", excerpt: quote, citation_validated: true }],
    source: {
      field: "body",
      exact_quote: quote,
      paragraph_index: 0,
      context_before: null,
      context_after: null,
    },
  };
}

const personCandidate = candidate("person", "市教育局局长王海涛", "职务待核验");
const typoCandidate = candidate("basic_text", "座谈谈会", "疑似错别字", "座谈会");
const consistencyCandidate = candidate(
  "consistency",
  "义务教育阶段在校生共128万人",
  "文内数字前后矛盾",
);
const citationCandidate = candidate("citation", "王强在总结时强调开学工作", "引语归属待核验");

function recordingRuntime(inner: Specialist[]): {
  runtime: SpecialistRuntime;
  seen: SpecialistTask[];
} {
  const seen: SpecialistTask[] = [];
  const recorded: Specialist[] = inner.map((specialist) => ({
    id: specialist.id,
    provider: specialist.provider,
    model: specialist.model,
    run(task) {
      seen.push(task);
      return specialist.run(task);
    },
  }));
  return { runtime: createSpecialistRuntime(recorded, { nowMs: () => 0 }), seen };
}

describe("review-core specialist runtime integration", () => {
  test("stays off unless a runtime is injected, even if the env flag is set", async () => {
    process.env.REVIEW_SPECIALISTS_ENABLED = "1";
    const model = new FixtureReviewModel([personCandidate]);
    const implicit = await createReview(article, model, {
      disableRules: true,
      disableRetrieval: true,
    });
    const envRuntime = createSpecialistRuntimeFromEnv();
    delete process.env.REVIEW_SPECIALISTS_ENABLED;

    expect(envRuntime).toBeNull();
    expect(implicit.pipeline.specialists_enabled).toBe(false);
    expect(implicit.pipeline.specialist_orchestration).toBeUndefined();
    expect(implicit.findings.every((item) => item.status === "pending")).toBe(true);
  });

  test("injected fake specialists run after findings exist and never receive the full article", async () => {
    const { runtime, seen } = recordingRuntime(createFakeSpecialists());
    const result = await createReview(
      article,
      new FixtureReviewModel([personCandidate, typoCandidate, consistencyCandidate]),
      {
        disableRules: true,
        disableRetrieval: true,
        specialistRuntime: runtime,
      },
    );

    expect(result.pipeline.specialists_enabled).toBe(true);
    expect(result.pipeline.specialist_orchestration?.enabled).toBe(true);
    expect(result.pipeline.specialist_orchestration?.target_model).toBe(SPECIALIST_TARGET_MODEL);
    expect(result.pipeline.specialist_orchestration?.dispatched).toEqual([
      "fact_check",
      "news_edit",
    ]);
    expect(result.pipeline.specialist_orchestration?.budget).toEqual({
      max_specialists: SPECIALIST_MAX_PER_ARTICLE,
      used: 2,
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((task) => task.article === undefined)).toBe(true);
    expect(seen.every((task) => task.constraints.allowExternalRetrieval === false)).toBe(true);
    expect(
      seen.every((task) => !specialistTaskContainsFullArticle(task, { ...article, version: 1 })),
    ).toBe(true);
    expect(JSON.stringify(seen).includes("SECRET_FULL_TEXT_MARKER")).toBe(false);
    expect(seen.every((task) => task.preliminaryFindings.every((item) => item.type !== "basic_text"))).toBe(
      true,
    );
    expect(
      result.pipeline.specialist_orchestration?.results.every(
        (item) => item.provenance.provider === "fixture" && item.provenance.invoked,
      ),
    ).toBe(true);
    const typo = result.findings.find((item) => item.type === "basic_text");
    expect(typo?.status).toBe("pending");
    expect(typo?.status).not.toBe("verify");
  });

  test("basic_text-only findings do not call a model specialist", async () => {
    const { runtime, seen } = recordingRuntime(createFakeSpecialists());
    const result = await createReview(article, new FixtureReviewModel([typoCandidate]), {
      disableRules: true,
      disableRetrieval: true,
      specialistRuntime: runtime,
    });
    expect(seen).toEqual([]);
    expect(result.pipeline.specialist_orchestration?.dispatched).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.type).toBe("basic_text");
    expect(result.findings[0]?.status).toBe("pending");
  });

  test("timeout keeps the main finding and marks it 待人工核实", async () => {
    const runtime = createSpecialistRuntime(
      [new FakeFactCheckSpecialist({ behavior: "timeout" }), new FakeNewsEditSpecialist()],
      { deadlineMs: 30 },
    );
    const result = await createReview(
      article,
      new FixtureReviewModel([personCandidate, consistencyCandidate]),
      {
        disableRules: true,
        disableRetrieval: true,
        specialistRuntime: runtime,
      },
    );
    const person = result.findings.find((item) => item.type === "person");
    const consistency = result.findings.find((item) => item.type === "consistency");
    expect(person?.title).toBe(personCandidate.title);
    expect(person?.reason).toBe(personCandidate.reason);
    expect(person?.status).toBe("verify");
    expect(person?.requires_verification).toBe(true);
    expect(consistency?.status).toBe("pending");
    expect(
      result.pipeline.specialist_orchestration?.results.find(
        (item) => item.provenance.specialist === "fact_check",
      )?.provenance.status,
    ).toBe("timed_out");
  });

  test("failure keeps the main finding and marks it 待人工核实", async () => {
    const runtime = createSpecialistRuntime(
      [new FakeFactCheckSpecialist({ behavior: "failure" }), new FakeNewsEditSpecialist()],
      { nowMs: () => 0 },
    );
    const result = await createReview(article, new FixtureReviewModel([personCandidate]), {
      disableRules: true,
      disableRetrieval: true,
      specialistRuntime: runtime,
    });
    const person = result.findings.find((item) => item.type === "person");
    expect(person?.title).toBe("职务待核验");
    expect(person?.status).toBe("verify");
    expect(person?.requires_verification).toBe(true);
    expect(
      result.pipeline.specialist_orchestration?.judgments.some(
        (item) => item.reason === SPECIALIST_FAILURE_MESSAGE,
      ),
    ).toBe(true);
  });

  test("disagreement keeps both main findings and marks the span 待人工核实", async () => {
    const quote = "王强在总结时强调开学工作";
    const runtime = createSpecialistRuntime(
      [
        new FakeFactCheckSpecialist({
          catalog: {
            [quote]: candidate("citation", quote, "应改为王海涛", "王海涛在总结时强调开学工作"),
          },
        }),
        new FakeNewsEditSpecialist({
          catalog: {
            [quote]: candidate("citation", quote, "保留原文并核实", null),
          },
        }),
      ],
      { nowMs: () => 0 },
    );
    const result = await createReview(article, new FixtureReviewModel([citationCandidate]), {
      disableRules: true,
      disableRetrieval: true,
      specialistRuntime: runtime,
    });
    const citation = result.findings.find((item) => item.type === "citation");
    expect(citation?.title).toBe(citationCandidate.title);
    expect(citation?.suggestion.replacement).toBeNull();
    expect(citation?.status).toBe("verify");
    expect(citation?.requires_verification).toBe(true);
    expect(
      result.pipeline.specialist_orchestration?.judgments.some(
        (item) => item.reason === SPECIALIST_DISAGREEMENT_MESSAGE,
      ),
    ).toBe(true);
  });

  test("runtime failure degrades without dropping main findings", async () => {
    const exploding: SpecialistRuntime = {
      orchestrate() {
        return Promise.reject(new Error("runtime exploded"));
      },
    };
    const result = await createReview(
      article,
      new FixtureReviewModel([personCandidate, typoCandidate]),
      {
        disableRules: true,
        disableRetrieval: true,
        specialistRuntime: exploding,
      },
    );
    const person = result.findings.find((item) => item.type === "person");
    const typo = result.findings.find((item) => item.type === "basic_text");
    expect(person?.status).toBe("verify");
    expect(person?.requires_verification).toBe(true);
    expect(typo?.status).toBe("pending");
    expect(result.pipeline.specialists_enabled).toBe(true);
    expect(result.pipeline.specialist_orchestration?.warnings.some((item) => item.includes("exploded"))).toBe(
      true,
    );
  });

  test("passes local retrieved evidence and existing web evidence without the article body", async () => {
    const { runtime, seen } = recordingRuntime(createFakeSpecialists());
    const result = await createReview(
      article,
      new FixtureReviewModel([personCandidate, consistencyCandidate]),
      {
        disableRules: true,
        specialistRuntime: runtime,
        webEvidenceCollector: {
          collect() {
            return Promise.resolve({
              enabled: true as const,
              query_count: 2,
              results: [
                {
                  evidence: [
                    {
                      source_name: "教育部",
                      url: "https://example.invalid/edu",
                      title: "市教育局局长王海涛",
                      excerpt: "市教育局局长王海涛",
                      published_or_version_date: "2026-01-01",
                      retrieved_at: "2026-08-26T00:00:00.000Z",
                      source_tier: "official" as const,
                    },
                  ],
                  status: "retrieved" as const,
                  error_class: "none" as const,
                  message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
                  provenance: {
                    provider_id: "fake",
                    provider_kind: "fake_offline" as const,
                    live_network: false,
                    retrieved_at: "2026-08-26T00:00:00.000Z",
                    query_text: "市教育局局长王海涛",
                    fact_category: "person_title" as const,
                  },
                },
                {
                  evidence: [
                    {
                      source_name: "统计公报",
                      url: "https://example.invalid/stats",
                      title: "在校生统计",
                      excerpt: "义务教育阶段在校生共128万人",
                      published_or_version_date: "2026-01-01",
                      retrieved_at: "2026-08-26T00:00:00.000Z",
                      source_tier: "official" as const,
                    },
                  ],
                  status: "retrieved" as const,
                  error_class: "none" as const,
                  message: WEB_EVIDENCE_RETRIEVED_MESSAGE,
                  provenance: {
                    provider_id: "fake",
                    provider_kind: "fake_offline" as const,
                    live_network: false,
                    retrieved_at: "2026-08-26T00:00:00.000Z",
                    query_text: "义务教育阶段在校生共128万人",
                    fact_category: "number" as const,
                  },
                },
              ],
            });
          },
        },
      },
    );

    const factTask = seen.find((task) => task.specialist === "fact_check");
    const newsTask = seen.find((task) => task.specialist === "news_edit");
    expect(result.pipeline.web_evidence?.enabled).toBe(true);
    expect(result.pipeline.web_evidence?.query_count).toBe(2);
    expect(factTask?.webEvidence.map((item) => item.url)).toEqual(["https://example.invalid/edu"]);
    expect(newsTask?.webEvidence.map((item) => item.url)).toEqual(["https://example.invalid/stats"]);
    expect(JSON.stringify(seen).includes("SECRET_FULL_TEXT_MARKER")).toBe(false);
    expect(JSON.stringify(seen).includes(article.body)).toBe(false);
  });
});
