import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SAMPLE_ARTICLE } from "../fixtures/sample-article";
import { DEGRADED_CAUTION } from "../services/contract";
import { FixtureReviewClient, type FixtureScenario } from "../services/fixture-client";
import { ApiError, type ReviewClient } from "../services/types";
import { ReviewSession } from "../session/review-session";

async function run(
  scenario: FixtureScenario,
  body = SAMPLE_ARTICLE.body,
): Promise<ReviewSession> {
  const session = new ReviewSession({
    client: new FixtureReviewClient(scenario),
    allowSample: true,
    sleep: async () => undefined,
  });
  session.fillSample();
  session.setBody(body);
  session.setPrivacyChecked(true);
  await session.submit();
  return session;
}

describe("fixture happy path", () => {
  it("goes input → queued/running → succeeded → decision → delete cleanup", async () => {
    const phases: string[] = [];
    const client = new FixtureReviewClient("success");
    const session = new ReviewSession({
      client,
      allowSample: true,
      sleep: async () => undefined,
    });
    session.subscribe(() => phases.push(session.getPhase()));
    session.fillSample();
    session.setPrivacyChecked(true);
    await session.submit();

    const view = session.toViewModel();
    assert.equal(view.phase, "result");
    assert.equal(view.cautionVisible, false);
    assert.equal(view.findings.length, 1);
    assert.equal(view.findings[0]?.title, "存在冗余助词");
    assert.equal(view.remainingLabel, "2 / 3");
    assert.ok(phases.includes("progress"));
    assert.match(session.getReview()?.status ?? "", /succeeded/);

    session.selectFinding("fixture-finding-1");
    await session.decide("accept");
    const accepted = session.getReview();
    assert.equal(accepted?.findings[0]?.status, "accepted");
    assert.match(accepted?.article.body ?? "", /已完成专项检查/);
    assert.equal(accepted?.article.version, 2);

    const reviewId = accepted?.review_id;
    assert.ok(reviewId);
    await session.deleteAndReset();
    const reset = session.toViewModel();
    assert.equal(reset.phase, "input");
    assert.equal(reset.hasReview, false);
    assert.equal(reset.findings.length, 0);
    assert.equal(reset.sheetVisible, false);
    assert.equal(reset.errorVisible, false);
    assert.equal(reset.title, "");
    assert.equal(reset.body, "");
    assert.equal(reset.privacyChecked, false);
    assert.equal(reset.canSubmit, false);
    assert.equal(reset.remainingLabel, "2 / 3");
    assert.match(reset.quotaText, /今日剩余 2 \/ 3 篇/);
    assert.equal(session.getReview(), null);
    assert.equal(client.getStored(reviewId), null);
    assert.equal((await client.login()).remaining, 2);
  });

  it("keeps the draft and results when delete fails", async () => {
    const inner = new FixtureReviewClient("success");
    const client: ReviewClient = {
      login: () => inner.login(),
      createReview: (input) => inner.createReview(input),
      getReview: (reviewId) => inner.getReview(reviewId),
      decide: (reviewId, findingId, input) => inner.decide(reviewId, findingId, input),
      deleteReview: async () => {
        throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "Fixture delete failure");
      },
    };
    const session = new ReviewSession({
      client,
      allowSample: true,
      sleep: async () => undefined,
    });
    session.fillSample();
    session.setPrivacyChecked(true);
    await session.submit();
    session.selectFinding("fixture-finding-1");
    const before = session.toViewModel();

    await session.deleteAndReset();
    const after = session.toViewModel();
    assert.equal(after.phase, "result");
    assert.equal(after.title, before.title);
    assert.equal(after.body, before.body);
    assert.equal(after.privacyChecked, true);
    assert.equal(after.hasReview, true);
    assert.equal(after.findings.length, 1);
    assert.equal(after.selectedFinding?.finding_id, "fixture-finding-1");
    assert.equal(after.errorCode, "UPSTREAM_UNAVAILABLE");
    assert.equal(after.remainingLabel, "2 / 3");
    assert.ok(session.getReview());
  });
});

describe("degraded and terminal failures", () => {
  it("shows the frozen caution and never an empty-success copy for degraded results", async () => {
    const session = await run("degraded");
    const view = session.toViewModel();
    assert.equal(view.phase, "result");
    assert.equal(view.cautionVisible, true);
    assert.equal(view.cautionText, DEGRADED_CAUTION);
    assert.equal(view.emptyResultVisible, false);
    assert.equal(view.findings.length, 0);
    assert.doesNotMatch(view.cautionText, /未发现待处理问题/);
  });

  it("surfaces failed and expired tasks as failure, not clean success", async () => {
    const failed = await run("failed");
    assert.equal(failed.getPhase(), "failure");
    assert.equal(failed.toViewModel().emptyResultVisible, false);
    assert.match(failed.toViewModel().cautionText, /不能视为稿件没有问题/);

    const expired = await run("expired");
    assert.equal(expired.getPhase(), "failure");
    assert.match(expired.toViewModel().cautionText, /不能视为稿件没有问题/);
  });
});

describe("submit error states", () => {
  it("maps 401 and 403", async () => {
    const auth = await run("auth");
    assert.equal(auth.toViewModel().errorCode, "AUTH_REQUIRED");
    assert.equal(auth.toViewModel().errorKind, "auth");
    assert.equal(auth.getPhase(), "input");

    const forbidden = await run("forbidden");
    assert.equal(forbidden.toViewModel().errorCode, "FORBIDDEN");
    assert.equal(forbidden.toViewModel().errorKind, "forbidden");
  });

  it("maps 409 concurrency conflict", async () => {
    const session = await run("conflict");
    assert.equal(session.toViewModel().errorCode, "REVIEW_ALREADY_RUNNING");
    assert.equal(session.toViewModel().errorKind, "conflict");
  });

  it("maps 413 and 422", async () => {
    const tooLarge = await run("too-large");
    assert.equal(tooLarge.toViewModel().errorCode, "ARTICLE_TOO_LARGE");
    const rejected = await run("rejected");
    assert.equal(rejected.toViewModel().errorCode, "CONTENT_REJECTED");
  });

  it("maps 429 quota and rate limit", async () => {
    const quota = await run("quota");
    assert.equal(quota.toViewModel().errorCode, "DAILY_QUOTA_EXCEEDED");
    assert.equal(quota.toViewModel().errorKind, "quota");
    const limited = await run("rate-limit");
    assert.equal(limited.toViewModel().errorCode, "RATE_LIMITED");
  });

  it("maps 503 unavailable", async () => {
    const session = await run("unavailable");
    assert.equal(session.toViewModel().errorCode, "UPSTREAM_UNAVAILABLE");
    assert.equal(session.toViewModel().errorKind, "capacity");
  });

  it("maps network, timeout, and empty response without success empty copy", async () => {
    const network = await run("network");
    assert.equal(network.toViewModel().errorCode, "NETWORK_UNAVAILABLE");
    assert.equal(network.getPhase(), "input");

    const timeout = await run("timeout");
    assert.equal(timeout.toViewModel().errorCode, "TIMEOUT");
    assert.match(timeout.toViewModel().errorMessage, /不能视为稿件没有问题/);
    assert.equal(timeout.toViewModel().emptyResultVisible, false);
    assert.equal(timeout.getPhase(), "failure");

    const empty = await run("empty");
    assert.equal(empty.toViewModel().errorCode, "EMPTY_RESPONSE");
    assert.match(empty.toViewModel().errorMessage, /不能视为稿件没有问题/);
    assert.equal(empty.getPhase(), "failure");
  });
});

describe("decision conflicts and local validation", () => {
  it("returns 409 version conflict from the fixture client", async () => {
    const client = new FixtureReviewClient("success");
    const session = new ReviewSession({ client, allowSample: true, sleep: async () => undefined });
    session.fillSample();
    session.setPrivacyChecked(true);
    await session.submit();
    const review = session.getReview();
    assert.ok(review);
    await assert.rejects(
      () =>
        client.decide(review.review_id, "fixture-finding-1", {
          action: "ignore",
          expected_article_version: 99,
          action_id: "action-conflict",
        }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "VERSION_CONFLICT");
        return true;
      },
    );
  });

  it("rejects an outdated privacy notice version", async () => {
    const client = new FixtureReviewClient("success");
    await assert.rejects(
      () =>
        client.createReview({
          title: "标题",
          body: "正文",
          privacy_notice_version: "public-v0",
        }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, "PRIVACY_NOTICE_OUTDATED");
        return true;
      },
    );
  });

  it("blocks submit until privacy is confirmed and input is valid", async () => {
    const session = new ReviewSession({
      client: new FixtureReviewClient("success"),
      sleep: async () => undefined,
    });
    await session.submit();
    assert.equal(session.toViewModel().errorMessage, "请填写稿件标题。");
    session.setTitle("标题");
    session.setBody("正文");
    await session.submit();
    assert.equal(session.toViewModel().errorMessage, "请先确认已阅读隐私与 AI 使用说明。");
    assert.equal(session.getPhase(), "input");
  });
});
