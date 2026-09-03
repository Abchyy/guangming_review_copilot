import { SAMPLE_ARTICLE } from "../fixtures/sample-article";
import {
  AI_DISCLAIMER,
  BODY_MAX_LENGTH,
  FIXTURE_BANNER,
  PRIVACY_NOTICE,
  PUBLIC_PRIVACY_NOTICE_VERSION,
  PRODUCT_NAME,
  TITLE_MAX_LENGTH,
  buildArticleSegments,
  createActionId,
  isTerminalReviewStatus,
  progressCopy,
  resultPresentation,
  toUserError,
  validateReviewInput,
  type ArticleSegment,
} from "../services/contract";
import type {
  FindingAction,
  FindingStatus,
  LoginResult,
  ReviewClient,
  ReviewFinding,
  ReviewResource,
  ReviewStatus,
} from "../services/types";
import {
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
} from "../services/types";

export type SessionPhase = "input" | "progress" | "result" | "failure";

export type FindingView = {
  finding_id: string;
  title: string;
  reason: string;
  severity: string;
  severityLabel: string;
  quoted: string;
  suggestion: string;
  replacement: string | null;
  status: FindingStatus;
  statusLabel: string;
  canAccept: boolean;
  pending: boolean;
};

export type ReviewViewModel = {
  productName: string;
  aiDisclaimer: string;
  fixtureBanner: string;
  showFixtureBanner: boolean;
  showSampleButton: boolean;
  phase: SessionPhase;
  title: string;
  body: string;
  titleCount: string;
  bodyCount: string;
  titleOver: boolean;
  bodyOver: boolean;
  privacyChecked: boolean;
  privacyText: string;
  quotaText: string;
  submitting: boolean;
  canSubmit: boolean;
  progressTitle: string;
  progressDetail: string;
  errorVisible: boolean;
  errorCode: string;
  errorMessage: string;
  errorKind: string;
  cautionVisible: boolean;
  cautionText: string;
  emptyResultVisible: boolean;
  emptyResultTitle: string;
  emptyResultDetail: string;
  articleTitle: string;
  segments: ArticleSegment[];
  findings: FindingView[];
  selectedFinding: FindingView | null;
  sheetVisible: boolean;
  remainingLabel: string;
  hasReview: boolean;
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  pending: "待处理",
  accepted: "已接受",
  ignored: "已忽略",
  verify: "待人工核实",
  invalidated: "已失效",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type ReviewSessionOptions = {
  client: ReviewClient;
  allowSample?: boolean;
  sleep?: (ms: number) => Promise<void>;
  createActionId?: () => string;
};

export class ReviewSession {
  private readonly client: ReviewClient;
  private readonly allowSample: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly makeActionId: () => string;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private title = "";
  private body = "";
  private privacyChecked = false;
  private phase: SessionPhase = "input";
  private submitting = false;
  private review: ReviewResource | null = null;
  private pollAfterMs = PUBLIC_DEFAULT_POLL_AFTER_MS;
  private selectedFindingId: string | null = null;
  private login: LoginResult | null = null;
  private error: { code: string; message: string } | null = null;

  constructor(options: ReviewSessionOptions) {
    this.client = options.client;
    this.allowSample = Boolean(options.allowSample);
    this.sleep = options.sleep ?? delay;
    this.makeActionId = options.createActionId ?? createActionId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
  }

  getReview(): ReviewResource | null {
    return this.review;
  }

  getPhase(): SessionPhase {
    return this.phase;
  }

  setLocalError(message: string, code = "UI_ERROR"): void {
    this.error = { code, message };
    this.emit();
  }

  toViewModel(): ReviewViewModel {
    const inputError = validateReviewInput(this.title, this.body);
    const presentation = this.review ? resultPresentation(this.review) : null;
    const findings = (this.review?.findings ?? []).map((finding) => this.toFindingView(finding));
    const selectedFinding =
      findings.find((finding) => finding.finding_id === this.selectedFindingId) ?? null;
    const progress =
      this.review && (this.review.status === "queued" || this.review.status === "running")
        ? progressCopy(this.review.status)
        : { title: "正在提交审校", detail: "正在创建审校任务。" };
    const remaining = this.login ? `${this.login.remaining} / ${this.login.daily_limit}` : "—";
    return {
      productName: PRODUCT_NAME,
      aiDisclaimer: AI_DISCLAIMER,
      fixtureBanner: FIXTURE_BANNER,
      showFixtureBanner: this.allowSample,
      showSampleButton: this.allowSample && this.phase === "input",
      phase: this.phase,
      title: this.title,
      body: this.body,
      titleCount: `${this.title.length} / ${TITLE_MAX_LENGTH}`,
      bodyCount: `${this.body.length} / ${BODY_MAX_LENGTH}`,
      titleOver: this.title.length > TITLE_MAX_LENGTH,
      bodyOver: this.body.length > BODY_MAX_LENGTH,
      privacyChecked: this.privacyChecked,
      privacyText: PRIVACY_NOTICE,
      quotaText: this.login
        ? `今日剩余 ${remaining} 篇`
        : `每用户每日最多 ${PUBLIC_DEFAULT_DAILY_LIMIT} 篇，同时只能运行 ${PUBLIC_DEFAULT_RUNNING_LIMIT} 个任务。`,
      submitting: this.submitting,
      canSubmit:
        this.phase === "input" &&
        !this.submitting &&
        this.privacyChecked &&
        !inputError,
      progressTitle: progress.title,
      progressDetail: progress.detail,
      errorVisible: Boolean(this.error),
      errorCode: this.error?.code ?? "",
      errorMessage: this.error?.message ?? "",
      errorKind: this.errorKind(this.error?.code),
      cautionVisible: Boolean(presentation?.caution),
      cautionText: presentation?.caution ? presentation.detail : "",
      emptyResultVisible: presentation?.kind === "empty-success",
      emptyResultTitle: presentation?.kind === "empty-success" ? presentation.title : "",
      emptyResultDetail: presentation?.kind === "empty-success" ? presentation.detail : "",
      articleTitle: this.review?.article.title ?? this.title,
      segments: buildArticleSegments(this.review?.article.body ?? "", this.review?.findings ?? []),
      findings,
      selectedFinding,
      sheetVisible: Boolean(selectedFinding),
      remainingLabel: remaining,
      hasReview: Boolean(this.review),
    };
  }

  setTitle(title: string): void {
    this.title = title;
    this.emit();
  }

  setBody(body: string): void {
    this.body = body;
    this.emit();
  }

  setPrivacyChecked(checked: boolean): void {
    this.privacyChecked = checked;
    this.emit();
  }

  fillSample(): void {
    if (!this.allowSample || this.phase !== "input") {
      return;
    }
    this.title = SAMPLE_ARTICLE.title;
    this.body = SAMPLE_ARTICLE.body;
    this.emit();
  }

  selectFinding(findingId: string | null): void {
    this.selectedFindingId = findingId;
    this.emit();
  }

  async submit(): Promise<void> {
    if (this.submitting || this.phase === "progress") {
      return;
    }
    const validation = validateReviewInput(this.title, this.body);
    if (validation) {
      this.error = { code: "INVALID_REQUEST", message: validation };
      this.emit();
      return;
    }
    if (!this.privacyChecked) {
      this.error = { code: "INVALID_REQUEST", message: "请先确认已阅读隐私与 AI 使用说明。" };
      this.emit();
      return;
    }

    const token = ++this.generation;
    this.submitting = true;
    this.error = null;
    this.phase = "progress";
    this.review = null;
    this.selectedFindingId = null;
    this.emit();

    try {
      const login = await this.client.login();
      if (token !== this.generation) {
        return;
      }
      this.login = login;
      const created = await this.client.createReview({
        title: this.title,
        body: this.body,
        privacy_notice_version: PUBLIC_PRIVACY_NOTICE_VERSION,
      });
      if (token !== this.generation) {
        return;
      }
      this.consumeDailyQuota();
      this.pollAfterMs = created.poll_after_ms || PUBLIC_DEFAULT_POLL_AFTER_MS;
      this.review = {
        review_id: created.review_id,
        status: "queued",
        article: { title: this.title, body: this.body, version: 1 },
        findings: [],
        degradation_notice: null,
        failure_code: null,
        created_at: created.expires_at,
        updated_at: created.expires_at,
        expires_at: created.expires_at,
      };
      this.emit();
      await this.pollUntilTerminal(created.review_id, token);
    } catch (error) {
      if (token !== this.generation) {
        return;
      }
      this.error = toUserError(error);
      if (this.review) {
        this.phase = "failure";
      } else {
        this.phase = "input";
        this.selectedFindingId = null;
      }
    } finally {
      if (token === this.generation) {
        this.submitting = false;
        this.emit();
      }
    }
  }

  async decide(action: FindingAction): Promise<void> {
    const review = this.review;
    const findingId = this.selectedFindingId;
    if (!review || !findingId || this.submitting) {
      return;
    }
    const token = this.generation;
    this.submitting = true;
    this.error = null;
    this.emit();
    try {
      const result = await this.client.decide(review.review_id, findingId, {
        action,
        expected_article_version: review.article.version,
        action_id: this.makeActionId(),
      });
      if (token !== this.generation) {
        return;
      }
      this.applyReview(result.request_id, result.review);
      this.body = result.review.article.body;
      this.title = result.review.article.title;
    } catch (error) {
      if (token !== this.generation) {
        return;
      }
      this.error = toUserError(error);
    } finally {
      if (token === this.generation) {
        this.submitting = false;
        this.emit();
      }
    }
  }

  async deleteAndReset(): Promise<void> {
    const token = ++this.generation;
    const reviewId = this.review?.review_id;
    this.submitting = true;
    this.error = null;
    this.emit();
    try {
      if (reviewId) {
        await this.client.deleteReview(reviewId);
      }
      if (token !== this.generation) {
        return;
      }
      this.clearDraftAfterDelete();
    } catch (error) {
      if (token !== this.generation) {
        return;
      }
      this.error = toUserError(error);
      this.phase = this.review ? this.phaseFor(this.review.status) : "input";
    } finally {
      if (token === this.generation) {
        this.submitting = false;
        this.emit();
      }
    }
  }

  resetLocalState(): void {
    this.generation += 1;
    this.phase = "input";
    this.submitting = false;
    this.review = null;
    this.selectedFindingId = null;
    this.error = null;
    this.pollAfterMs = PUBLIC_DEFAULT_POLL_AFTER_MS;
    this.emit();
  }

  private consumeDailyQuota(): void {
    if (!this.login) {
      return;
    }
    this.login.remaining = Math.max(0, this.login.remaining - 1);
  }

  private clearDraftAfterDelete(): void {
    this.phase = "input";
    this.review = null;
    this.selectedFindingId = null;
    this.error = null;
    this.pollAfterMs = PUBLIC_DEFAULT_POLL_AFTER_MS;
    this.title = "";
    this.body = "";
    this.privacyChecked = false;
  }

  private async pollUntilTerminal(reviewId: string, token: number): Promise<void> {
    while (token === this.generation) {
      await this.sleep(this.pollAfterMs);
      if (token !== this.generation) {
        return;
      }
      const result = await this.client.getReview(reviewId);
      if (token !== this.generation) {
        return;
      }
      this.applyReview(result.request_id, result.review);
      if (isTerminalReviewStatus(result.review.status)) {
        return;
      }
    }
  }

  private applyReview(_requestId: string, review: ReviewResource): void {
    this.review = review;
    this.phase = this.phaseFor(review.status);
    if (this.selectedFindingId) {
      const stillThere = review.findings.some((item) => item.finding_id === this.selectedFindingId);
      if (!stillThere) {
        this.selectedFindingId = null;
      }
    }
    this.emit();
  }

  private phaseFor(status: ReviewStatus): SessionPhase {
    if (status === "queued" || status === "running") {
      return "progress";
    }
    if (status === "failed" || status === "expired" || status === "cancelled") {
      return "failure";
    }
    return "result";
  }

  private errorKind(code: string | undefined): string {
    switch (code) {
      case "AUTH_REQUIRED":
        return "auth";
      case "FORBIDDEN":
        return "forbidden";
      case "VERSION_CONFLICT":
      case "REVIEW_ALREADY_RUNNING":
      case "IDEMPOTENCY_CONFLICT":
        return "conflict";
      case "ARTICLE_TOO_LARGE":
        return "too-large";
      case "CONTENT_REJECTED":
        return "rejected";
      case "DAILY_QUOTA_EXCEEDED":
      case "RATE_LIMITED":
        return "quota";
      case "REVIEW_CAPACITY_EXHAUSTED":
      case "UPSTREAM_UNAVAILABLE":
      case "NOT_IMPLEMENTED":
        return "capacity";
      case "NETWORK_UNAVAILABLE":
      case "TIMEOUT":
        return "network";
      case "EMPTY_RESPONSE":
        return "empty";
      default:
        return "generic";
    }
  }

  private toFindingView(finding: ReviewFinding): FindingView {
    return {
      finding_id: finding.finding_id,
      title: finding.title,
      reason: finding.reason,
      severity: finding.severity,
      severityLabel: SEVERITY_LABEL[finding.severity] ?? finding.severity,
      quoted: finding.source_span.quoted_text,
      suggestion: finding.suggestion.text,
      replacement: finding.suggestion.replacement,
      status: finding.status,
      statusLabel: STATUS_LABEL[finding.status],
      canAccept: Boolean(finding.suggestion.replacement) && finding.status === "pending",
      pending: finding.status === "pending" || finding.status === "verify",
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
