import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createReviewPage,
  defaultReviewPageUi,
  DELETE_CANCEL_TEXT,
  DELETE_CONFIRM_CONTENT,
  DELETE_CONFIRM_TEXT,
  DELETE_CONFIRM_TITLE,
  DELETE_MODAL_ERROR,
  type DeleteConfirmOptions,
  type DeleteConfirmResult,
  type ReviewPageUi,
} from "../pages/review/page";
import { FixtureReviewClient } from "../services/fixture-client";
import type { ReviewClient } from "../services/types";
import { ReviewSession, type ReviewViewModel } from "../session/review-session";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type PageHandle = ReturnType<typeof createReviewPage> & {
  data: ReviewViewModel;
  setData(update: Partial<ReviewViewModel> | Record<string, unknown>): void;
};

function mountPage(args: {
  ui: ReviewPageUi;
  client?: ReviewClient;
}): {
  page: PageHandle;
  session: ReviewSession;
  client: ReviewClient;
  inner: FixtureReviewClient;
  deleteCalls: { count: number };
} {
  const inner = args.client instanceof FixtureReviewClient
    ? args.client
    : new FixtureReviewClient("success");
  const deleteCalls = { count: 0 };
  const client: ReviewClient = {
    login: () => inner.login(),
    createReview: (input) => inner.createReview(input),
    getReview: (reviewId) => inner.getReview(reviewId),
    decide: (reviewId, findingId, input) => inner.decide(reviewId, findingId, input),
    deleteReview: async (reviewId) => {
      deleteCalls.count += 1;
      return inner.deleteReview(reviewId);
    },
  };
  const session = new ReviewSession({
    client,
    allowSample: true,
    sleep: async () => undefined,
  });
  const options = createReviewPage({
    ui: args.ui,
    createSession: () => session,
  });
  const page = {
    ...options,
    data: options.data,
    setData(update: Partial<ReviewViewModel> | Record<string, unknown>) {
      Object.assign(this.data, update);
    },
  } as PageHandle;
  page.onLoad({});
  return { page, session, client, inner, deleteCalls };
}

async function submitSample(page: PageHandle): Promise<void> {
  page.onFillSample();
  page.onTogglePrivacy();
  await page.onSubmit();
}

function recordingUi(next: () => Promise<DeleteConfirmResult>): {
  ui: ReviewPageUi;
  prompts: DeleteConfirmOptions[];
  errors: string[];
} {
  const prompts: DeleteConfirmOptions[] = [];
  const errors: string[] = [];
  return {
    prompts,
    errors,
    ui: {
      async confirmDelete(options) {
        prompts.push(options);
        return next();
      },
      notifyError(message) {
        errors.push(message);
      },
    },
  };
}

describe("review page delete button chain", () => {
  it("binds every delete button to onDelete", () => {
    const wxml = readFileSync(join(root, "pages/review/index.wxml"), "utf8");
    assert.match(wxml, /catchtap="onDelete">取消并删除任务</);
    assert.match(wxml, /catchtap="onDelete">删除任务</);
    assert.match(wxml, /catchtap="onDelete">删除本篇审校</);
    assert.equal((wxml.match(/catchtap="onDelete"/g) ?? []).length, 3);
    assert.doesNotMatch(wxml, /bindtap="onDelete"/);
  });

  it("opens a confirm modal when the delete button is tapped", async () => {
    const recorded = recordingUi(async () => ({ confirm: false, cancel: true }));
    const { page } = mountPage({ ui: recorded.ui });
    await submitSample(page);
    assert.equal(page.data.phase, "result");

    await page.onDelete();
    assert.equal(recorded.prompts.length, 1);
    assert.equal(recorded.prompts[0]?.title, DELETE_CONFIRM_TITLE);
    assert.equal(recorded.prompts[0]?.content, DELETE_CONFIRM_CONTENT);
    assert.equal(recorded.prompts[0]?.confirmText, DELETE_CONFIRM_TEXT);
    assert.equal(recorded.prompts[0]?.cancelText, DELETE_CANCEL_TEXT);
    assert.equal(recorded.prompts[0]?.showCancel, true);
  });

  it("leaves the page unchanged when the user cancels", async () => {
    const recorded = recordingUi(async () => ({ confirm: false, cancel: true }));
    const { page, session, deleteCalls } = mountPage({ ui: recorded.ui });
    await submitSample(page);
    const before = { ...page.data, findings: [...page.data.findings] };
    const reviewId = session.getReview()?.review_id;
    assert.ok(reviewId);

    await page.onDelete();
    assert.equal(deleteCalls.count, 0);
    assert.equal(page.data.phase, "result");
    assert.equal(page.data.title, before.title);
    assert.equal(page.data.body, before.body);
    assert.equal(page.data.privacyChecked, true);
    assert.equal(page.data.hasReview, true);
    assert.equal(page.data.findings.length, before.findings.length);
    assert.equal(session.getReview()?.review_id, reviewId);
  });

  it("deletes once after confirm and returns to a blank input page with 2/3 remaining", async () => {
    const recorded = recordingUi(async () => ({ confirm: true, cancel: false }));
    const { page, session, inner, deleteCalls } = mountPage({ ui: recorded.ui });
    await submitSample(page);
    const reviewId = session.getReview()?.review_id;
    assert.ok(reviewId);
    assert.equal(page.data.remainingLabel, "2 / 3");

    await page.onDelete();
    assert.equal(deleteCalls.count, 1);
    assert.equal(page.data.phase, "input");
    assert.equal(page.data.title, "");
    assert.equal(page.data.body, "");
    assert.equal(page.data.privacyChecked, false);
    assert.equal(page.data.canSubmit, false);
    assert.equal(page.data.hasReview, false);
    assert.equal(page.data.findings.length, 0);
    assert.equal(page.data.remainingLabel, "2 / 3");
    assert.match(page.data.quotaText, /今日剩余 2 \/ 3 篇/);
    assert.equal(session.getReview(), null);
    assert.equal(inner.getStored(reviewId), null);
  });

  it("does not call deleteAndReset twice if the button is tapped while the modal is open", async () => {
    let release: ((result: DeleteConfirmResult) => void) | undefined;
    const pending = new Promise<DeleteConfirmResult>((resolve) => {
      release = resolve;
    });
    const recorded = recordingUi(() => pending);
    const { page, deleteCalls } = mountPage({ ui: recorded.ui });
    await submitSample(page);

    const first = page.onDelete();
    const second = page.onDelete();
    assert.equal(recorded.prompts.length, 1);
    release?.({ confirm: true, cancel: false });
    await Promise.all([first, second]);
    assert.equal(deleteCalls.count, 1);
  });

  it("shows a visible error when the confirm modal fails and does not delete", async () => {
    const recorded = recordingUi(async () => {
      throw new Error("showModal:fail");
    });
    const { page, session, deleteCalls } = mountPage({ ui: recorded.ui });
    await submitSample(page);
    const reviewId = session.getReview()?.review_id;
    assert.ok(reviewId);

    await page.onDelete();
    assert.equal(deleteCalls.count, 0);
    assert.equal(page.data.phase, "result");
    assert.equal(page.data.hasReview, true);
    assert.equal(page.data.errorVisible, true);
    assert.equal(page.data.errorCode, "MODAL_UNAVAILABLE");
    assert.equal(page.data.errorMessage, DELETE_MODAL_ERROR);
    assert.deepEqual(recorded.errors, [DELETE_MODAL_ERROR]);
    assert.equal(session.getReview()?.review_id, reviewId);
  });

  it("surfaces wx.showModal failures through the default UI adapter", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const toasts: string[] = [];
    (globalThis as { wx?: unknown }).wx = {
      login() {},
      request() {},
      showToast(options: { title: string }) {
        toasts.push(options.title);
      },
      showModal(options: {
        success?: (result: { confirm: boolean; cancel: boolean }) => void;
        fail?: (error: { errMsg: string }) => void;
      }) {
        calls.push(options as unknown as Record<string, unknown>);
        options.fail?.({ errMsg: "showModal:fail" });
      },
    };
    const { page, deleteCalls } = mountPage({ ui: defaultReviewPageUi() });
    await submitSample(page);
    await page.onDelete();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.title, DELETE_CONFIRM_TITLE);
    assert.equal(deleteCalls.count, 0);
    assert.equal(page.data.errorVisible, true);
    assert.equal(page.data.errorMessage, DELETE_MODAL_ERROR);
    assert.deepEqual(toasts, [DELETE_MODAL_ERROR]);
  });
});
