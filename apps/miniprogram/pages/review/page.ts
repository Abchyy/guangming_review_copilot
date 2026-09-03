import { createReviewClient } from "../../services/client";
import { isFixtureScenario } from "../../services/fixture-client";
import { ReviewSession, type ReviewViewModel } from "../../session/review-session";

export const DELETE_CONFIRM_TITLE = "删除这篇审校？";
export const DELETE_CONFIRM_CONTENT = "删除后不可恢复，稿件和审校意见都会从服务端清除。";
export const DELETE_CONFIRM_TEXT = "删除";
export const DELETE_CANCEL_TEXT = "取消";
export const DELETE_MODAL_ERROR = "无法打开删除确认，请重试。";

export type DeleteConfirmResult = {
  confirm: boolean;
  cancel: boolean;
};

export type DeleteConfirmOptions = {
  title: string;
  content: string;
  showCancel: boolean;
  cancelText: string;
  confirmText: string;
  confirmColor: string;
};

export type ReviewPageUi = {
  confirmDelete(options: DeleteConfirmOptions): Promise<DeleteConfirmResult>;
  notifyError(message: string): void;
};

export type ReviewPageConfig = {
  ui?: ReviewPageUi;
  createSession?: (query?: Record<string, string>) => ReviewSession;
};

type ReviewPageInstance = {
  data: ReviewViewModel;
  session: ReviewSession | null;
  unsubscribe: (() => void) | null;
  deletePromptOpen: boolean;
  setData(update: Partial<ReviewViewModel> | Record<string, unknown>, callback?: () => void): void;
};

function emptyView(): ReviewViewModel {
  return {
    productName: "AI 审校助手",
    aiDisclaimer: "",
    fixtureBanner: "",
    showFixtureBanner: false,
    showSampleButton: false,
    phase: "input",
    title: "",
    body: "",
    titleCount: "0 / 200",
    bodyCount: "0 / 10000",
    titleOver: false,
    bodyOver: false,
    privacyChecked: false,
    privacyText: "",
    quotaText: "",
    submitting: false,
    canSubmit: false,
    progressTitle: "",
    progressDetail: "",
    errorVisible: false,
    errorCode: "",
    errorMessage: "",
    errorKind: "",
    cautionVisible: false,
    cautionText: "",
    emptyResultVisible: false,
    emptyResultTitle: "",
    emptyResultDetail: "",
    articleTitle: "",
    segments: [],
    findings: [],
    selectedFinding: null,
    sheetVisible: false,
    remainingLabel: "",
    hasReview: false,
  };
}

function getWx(): typeof wx {
  const runtime = globalThis as typeof globalThis & { wx?: typeof wx };
  if (!runtime.wx) {
    throw new Error("wx runtime is unavailable");
  }
  return runtime.wx;
}

export function defaultReviewPageUi(): ReviewPageUi {
  return {
    confirmDelete(options) {
      return new Promise((resolve, reject) => {
        getWx().showModal({
          ...options,
          success: (result) => {
            resolve({ confirm: Boolean(result.confirm), cancel: Boolean(result.cancel) });
          },
          fail: (error) => {
            reject(new Error(error.errMsg || DELETE_MODAL_ERROR));
          },
        });
      });
    },
    notifyError(message) {
      getWx().showToast({ title: message, icon: "none", duration: 2500 });
    },
  };
}

function defaultCreateSession(query?: Record<string, string>): ReviewSession {
  const rawScenario = query?.scenario;
  const scenario = isFixtureScenario(rawScenario) ? rawScenario : "success";
  const configured = createReviewClient(scenario);
  return new ReviewSession({
    client: configured.client,
    allowSample: Boolean(configured.fixture),
  });
}

export function createReviewPage(config: ReviewPageConfig = {}) {
  const ui = config.ui ?? defaultReviewPageUi();
  const createSession = config.createSession ?? defaultCreateSession;

  return {
    data: emptyView(),
    session: null as ReviewSession | null,
    unsubscribe: null as (() => void) | null,
    deletePromptOpen: false,

    onLoad(this: ReviewPageInstance, query?: Record<string, string>) {
      const session = createSession(query);
      this.session = session;
      this.unsubscribe = session.subscribe(() => {
        this.setData(session.toViewModel());
      });
      this.setData(session.toViewModel());
    },

    onUnload(this: ReviewPageInstance) {
      this.unsubscribe?.();
      this.session?.dispose();
      this.session = null;
      this.unsubscribe = null;
    },

    onTitleInput(this: ReviewPageInstance, event: { detail: { value: string } }) {
      this.session?.setTitle(event.detail.value);
    },

    onBodyInput(this: ReviewPageInstance, event: { detail: { value: string } }) {
      this.session?.setBody(event.detail.value);
    },

    onTogglePrivacy(this: ReviewPageInstance) {
      const session = this.session;
      if (!session) {
        return;
      }
      session.setPrivacyChecked(!session.toViewModel().privacyChecked);
    },

    onFillSample(this: ReviewPageInstance) {
      this.session?.fillSample();
    },

    onSubmit(this: ReviewPageInstance) {
      return this.session?.submit();
    },

    onSelectFinding(this: ReviewPageInstance, event: { currentTarget: { dataset: { id?: string } } }) {
      const findingId = event.currentTarget.dataset.id;
      if (findingId) {
        this.session?.selectFinding(findingId);
      }
    },

    onCloseSheet(this: ReviewPageInstance) {
      this.session?.selectFinding(null);
    },

    onAccept(this: ReviewPageInstance) {
      return this.session?.decide("accept");
    },

    onIgnore(this: ReviewPageInstance) {
      return this.session?.decide("ignore");
    },

    onVerify(this: ReviewPageInstance) {
      return this.session?.decide("verify");
    },

    async onDelete(this: ReviewPageInstance) {
      if (this.deletePromptOpen) {
        return;
      }
      this.deletePromptOpen = true;
      try {
        const result = await ui.confirmDelete({
          title: DELETE_CONFIRM_TITLE,
          content: DELETE_CONFIRM_CONTENT,
          showCancel: true,
          cancelText: DELETE_CANCEL_TEXT,
          confirmText: DELETE_CONFIRM_TEXT,
          confirmColor: "#8f2d22",
        });
        if (!result.confirm) {
          return;
        }
        await this.session?.deleteAndReset();
      } catch {
        this.session?.setLocalError(DELETE_MODAL_ERROR, "MODAL_UNAVAILABLE");
        try {
          ui.notifyError(DELETE_MODAL_ERROR);
        } catch {
          // The in-page error banner is already visible.
        }
      } finally {
        this.deletePromptOpen = false;
      }
    },

    onReset(this: ReviewPageInstance) {
      this.session?.resetLocalState();
    },
  };
}
