import { describe, expect, test } from "vitest";

import { ReviewDomainError, type ReviewCandidate } from "@grc/contracts";
import { openReviewDatabase } from "@grc/review-store";
import { FixtureReviewModel } from "@grc/providers";
import { createReview, type CreateReviewOptions } from "@grc/review-core";
import { ReviewStore } from "@grc/review-store";

function memoryStore(): ReviewStore {
  return new ReviewStore(openReviewDatabase(":memory:"));
}

function candidate(exactQuote: string, replacement: string | null, extras?: Partial<ReviewCandidate>): ReviewCandidate {
  return {
    type: extras?.type ?? "basic_text",
    severity: extras?.severity ?? "low",
    title: extras?.title ?? exactQuote,
    reason: extras?.reason ?? "reason",
    suggestion: extras?.suggestion ?? {
      text: replacement ?? "建议人工核实，无安全自动替换。",
      replacement,
    },
    confidence: 0.9,
    evidence: extras?.evidence ?? [
      { kind: "ai_judgment", excerpt: "judgment", citation_validated: false },
    ],
    source: extras?.source ?? {
      field: extras?.source?.field ?? "body",
      exact_quote: exactQuote,
      paragraph_index: 0,
      context_before: null,
      context_after: null,
    },
  };
}

async function persistReview(
  store: ReviewStore,
  title: string,
  body: string,
  candidates: ReviewCandidate[],
  options?: CreateReviewOptions,
) {
  const snapshot = await createReview(
    { title, body },
    new FixtureReviewModel(candidates),
    options,
  );
  store.insertCreatedReview(snapshot, snapshot.article);
  return snapshot;
}

describe("review store and decisions", () => {
  test("persists review, findings, and actions", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    const loaded = store.getReview(created.review_id);
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.findings[0]?.status).toBe("pending");

    const accepted = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "action-1",
    });
    expect(accepted.article.body).toBe("abc正确def");
    expect(store.getAction("action-1")?.action).toBe("accept");
  });

  test("action_id is unique and Accept is idempotent", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    const first = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "same-action",
    });
    const second = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "same-action",
    });
    expect(second.article.body).toBe("abc正确def");
    expect(second.article.version).toBe(first.article.version);
    expect(second.article.version).toBe(2);
  });

  test("transaction rollback leaves the article unchanged", () => {
    const db = openReviewDatabase(":memory:");
    db.exec(
      `INSERT INTO reviews VALUES ('r1','a1','t','body','t','body',1,'[]','{"provider":"fixture","model":null,"candidate_count":0,"located_count":0,"dropped_count":0,"elapsed_ms":1}','t','t')`,
    );
    expect(() =>
      db.transaction(() => {
        db.prepare("UPDATE reviews SET current_body = ? WHERE review_id = ?").run(
          "mutated",
          "r1",
        );
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    const row = db.prepare("SELECT current_body FROM reviews WHERE review_id = ?").get("r1") as {
      current_body: string;
    };
    expect(row.current_body).toBe("body");
  });

  test("basic body Accept", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    const next = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "accept-body",
    });
    expect(next.article.body).toBe("abc正确def");
    expect(next.findings[0]?.status).toBe("accepted");
    expect(next.article.version).toBe(2);
  });

  test("title Accept", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "错误标题", "正文保持不动", [
      candidate("错误标题", "正确标题", {
        source: {
          field: "title",
          exact_quote: "错误标题",
          paragraph_index: 0,
          context_before: null,
          context_after: null,
        },
      }),
    ]);
    const next = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "accept-title",
    });
    expect(next.article.title).toBe("正确标题");
    expect(next.article.body).toBe("正文保持不动");
    expect(next.article.version).toBe(2);
  });

  test("version mismatch returns 409 and does not mutate", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 9,
        actionId: "stale",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewDomainError);
      expect((error as ReviewDomainError).code).toBe("STALE_ARTICLE");
      expect((error as ReviewDomainError).status).toBe(409);
    }
    expect(store.getReview(created.review_id).article.body).toBe("abc错误def");
    expect(store.getReview(created.review_id).article.version).toBe(1);
  });

  test("quote mismatch returns 409 and does not mutate", async () => {
    const db = openReviewDatabase(":memory:");
    const store = new ReviewStore(db);
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    const tampered = {
      ...created.findings[0]!,
      source_span: { ...created.findings[0]!.source_span, quoted_text: "不是原文" },
    };
    db.prepare("UPDATE reviews SET findings_json = ? WHERE review_id = ?").run(
      JSON.stringify([tampered]),
      created.review_id,
    );
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 1,
        actionId: "mismatch",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("SPAN_MISMATCH");
      expect((error as ReviewDomainError).status).toBe(409);
    }
    expect(store.getReview(created.review_id).article.body).toBe("abc错误def");
  });

  test("null replacement cannot be accepted", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "数字128与182冲突", [
      candidate("128", null),
    ]);
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 1,
        actionId: "no-safe",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("NO_SAFE_REPLACEMENT");
      expect((error as ReviewDomainError).status).toBe(422);
    }
    expect(store.getReview(created.review_id).article.body).toBe("数字128与182冲突");
  });

  test("sequential Accept rebases the later span", async () => {
    const store = memoryStore();
    const body = "abc错误def还有错字ghi";
    const created = await persistReview(store, "标题", body, [
      candidate("错误", "正确的"),
      candidate("错字", "别字"),
    ]);
    const first = created.findings.find((item) => item.source_span.quoted_text === "错误")!;
    const second = created.findings.find((item) => item.source_span.quoted_text === "错字")!;
    const afterFirst = store.applyDecision({
      reviewId: created.review_id,
      findingId: first.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "seq-1",
    });
    expect(afterFirst.article.body).toBe("abc正确的def还有错字ghi");
    const rebased = afterFirst.findings.find((item) => item.finding_id === second.finding_id)!;
    expect(rebased.status).toBe("pending");
    expect(
      afterFirst.article.body.slice(
        rebased.source_span.start_offset,
        rebased.source_span.end_offset,
      ),
    ).toBe("错字");

    const afterSecond = store.applyDecision({
      reviewId: created.review_id,
      findingId: second.finding_id,
      action: "accept",
      expectedArticleVersion: 2,
      actionId: "seq-2",
    });
    expect(afterSecond.article.body).toBe("abc正确的def还有别字ghi");
    expect(afterSecond.article.version).toBe(3);
  });

  test("Ignore and Verify do not change article version", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def错字", [
      candidate("错误", "正确"),
      candidate("错字", "别字"),
    ]);
    const ignored = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "ignore",
      expectedArticleVersion: 1,
      actionId: "ignore-1",
    });
    expect(ignored.findings[0]?.status).toBe("ignored");
    expect(ignored.article.version).toBe(1);
    expect(ignored.article.body).toBe("abc错误def错字");

    const verified = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[1]!.finding_id,
      action: "verify",
      expectedArticleVersion: 1,
      actionId: "verify-1",
    });
    expect(verified.findings[1]?.status).toBe("verify");
    expect(verified.article.version).toBe(1);
  });

  test("illegal transitions are rejected", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "ignore",
      expectedArticleVersion: 1,
      actionId: "ig",
    });
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 1,
        actionId: "ig-then-accept",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("INVALID_STATUS_TRANSITION");
    }

    const created2 = await persistReview(store, "标题2", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    store.applyDecision({
      reviewId: created2.review_id,
      findingId: created2.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "acc",
    });
    try {
      store.applyDecision({
        reviewId: created2.review_id,
        findingId: created2.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 2,
        actionId: "acc-again",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("INVALID_STATUS_TRANSITION");
    }
  });

  test("invalidated finding cannot be accepted", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "错误字后面", [
      candidate("错误字", "正确的字"),
      candidate("误字", "X"),
    ], { promptMode: "baseline" });
    const first = created.findings.find((item) => item.source_span.quoted_text === "错误字")!;
    const overlapped = created.findings.find((item) => item.source_span.quoted_text === "误字")!;
    const after = store.applyDecision({
      reviewId: created.review_id,
      findingId: first.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "overlap-accept",
    });
    expect(after.findings.find((item) => item.finding_id === overlapped.finding_id)?.status).toBe(
      "invalidated",
    );
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: overlapped.finding_id,
        action: "accept",
        expectedArticleVersion: after.article.version,
        actionId: "accept-invalidated",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("FINDING_INVALIDATED");
    }
  });

  test("missing review or finding returns 404", () => {
    const store = memoryStore();
    try {
      store.applyDecision({
        reviewId: "missing",
        findingId: "x",
        action: "ignore",
        expectedArticleVersion: 1,
        actionId: "nope",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as ReviewDomainError).code).toBe("REVIEW_NOT_FOUND");
    }
  });

  test("applyDecision rolls back article, version, findings, and actions together", async () => {
    const db = openReviewDatabase(":memory:");
    const store = new ReviewStore(db);
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    db.exec(
      `CREATE TRIGGER fail_action BEFORE INSERT ON review_actions
       BEGIN SELECT RAISE(FAIL, 'injected failure'); END;`,
    );
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 1,
        actionId: "rollback-action",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewDomainError);
      expect((error as ReviewDomainError).code).toBe("STORAGE_FAILURE");
    }
    const loaded = store.getReview(created.review_id);
    expect(loaded.article.body).toBe("abc错误def");
    expect(loaded.article.version).toBe(1);
    expect(loaded.findings[0]?.status).toBe("pending");
    expect(store.getAction("rollback-action")).toBeUndefined();
  });

  test("same action_id and same payload is idempotent", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    const first = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "ignore",
      expectedArticleVersion: 1,
      actionId: "same-payload",
    });
    const second = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "ignore",
      expectedArticleVersion: 1,
      actionId: "same-payload",
    });
    expect(second.findings[0]?.status).toBe("ignored");
    expect(second.article.version).toBe(first.article.version);
  });

  test("same action_id and different payload returns 409 conflict", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc错误def", [
      candidate("错误", "正确"),
    ]);
    store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "ignore",
      expectedArticleVersion: 1,
      actionId: "conflict-action",
    });
    try {
      store.applyDecision({
        reviewId: created.review_id,
        findingId: created.findings[0]!.finding_id,
        action: "accept",
        expectedArticleVersion: 1,
        actionId: "conflict-action",
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewDomainError);
      expect((error as ReviewDomainError).code).toBe("ACTION_CONFLICT");
      expect((error as ReviewDomainError).status).toBe(409);
    }
    expect(store.getReview(created.review_id).findings[0]?.status).toBe("ignored");
    expect(store.getReview(created.review_id).article.body).toBe("abc错误def");
  });

  test("empty string replacement deletes the span", async () => {
    const store = memoryStore();
    const created = await persistReview(store, "标题", "abc删除这段def", [
      candidate("删除这段", ""),
    ]);
    const next = store.applyDecision({
      reviewId: created.review_id,
      findingId: created.findings[0]!.finding_id,
      action: "accept",
      expectedArticleVersion: 1,
      actionId: "delete-span",
    });
    expect(next.article.body).toBe("abcdef");
    expect(next.findings[0]?.status).toBe("accepted");
    expect(next.findings[0]?.source_span.quoted_text).toBe("");
  });
});
