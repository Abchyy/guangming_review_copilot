import { createReviewClient } from "../../services/client";
import { isFixtureScenario } from "../../services/fixture-client";
import { ReviewSession, type ReviewViewModel } from "../../session/review-session";

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

Page({
  data: emptyView(),
  session: null as ReviewSession | null,
  unsubscribe: null as (() => void) | null,

  onLoad(query?: Record<string, string>) {
    const rawScenario = query?.scenario;
    const scenario = isFixtureScenario(rawScenario) ? rawScenario : "success";
    const configured = createReviewClient(scenario);
    const session = new ReviewSession({
      client: configured.client,
      allowSample: Boolean(configured.fixture),
    });
    this.session = session;
    this.unsubscribe = session.subscribe(() => {
      this.setData(session.toViewModel());
    });
    this.setData(session.toViewModel());
  },

  onUnload() {
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = null;
    this.unsubscribe = null;
  },

  onTitleInput(event: { detail: { value: string } }) {
    this.session?.setTitle(event.detail.value);
  },

  onBodyInput(event: { detail: { value: string } }) {
    this.session?.setBody(event.detail.value);
  },

  onTogglePrivacy() {
    const session = this.session;
    if (!session) {
      return;
    }
    session.setPrivacyChecked(!session.toViewModel().privacyChecked);
  },

  onFillSample() {
    this.session?.fillSample();
  },

  onSubmit() {
    void this.session?.submit();
  },

  onSelectFinding(event: { currentTarget: { dataset: { id?: string } } }) {
    const findingId = event.currentTarget.dataset.id;
    if (findingId) {
      this.session?.selectFinding(findingId);
    }
  },

  onCloseSheet() {
    this.session?.selectFinding(null);
  },

  onAccept() {
    void this.session?.decide("accept");
  },

  onIgnore() {
    void this.session?.decide("ignore");
  },

  onVerify() {
    void this.session?.decide("verify");
  },

  onDelete() {
    wx.showModal({
      title: "删除这篇审校？",
      content: "删除后不可恢复，稿件和审校意见都会从服务端清除。",
      confirmText: "删除",
      confirmColor: "#8f2d22",
      success: (result) => {
        if (result.confirm) {
          void this.session?.deleteAndReset();
        }
      },
    });
  },

  onReset() {
    this.session?.resetLocalState();
  },
});
