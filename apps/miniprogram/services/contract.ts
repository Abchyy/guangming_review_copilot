import {
  ApiError,
  PUBLIC_API_ERROR_HTTP_STATUS,
  PUBLIC_BODY_MAX_LENGTH,
  PUBLIC_IDEMPOTENCY_KEY_PATTERN,
  PUBLIC_REVIEW_DEGRADATION_NOTICE,
  PUBLIC_TITLE_MAX_LENGTH,
  type PublicApiErrorCode,
  type ReviewFinding,
  type ReviewResource,
  type ReviewStatus,
} from "./types";

export const PRODUCT_NAME = "AI 审校助手";
export const AI_DISCLAIMER = "AI 辅助审校，最终判断由用户负责";
export const FIXTURE_BANNER = "当前为本地演示数据，未连接真实审校服务。";
export const PRIVACY_NOTICE =
  "本工具只帮助你检查自己的稿件，不提供发布、转载或传播。稿件默认保存不超过 24 小时，也可随时删除。我们不收集手机号、头像或昵称。";

export {
  PUBLIC_PRIVACY_NOTICE_VERSION,
  PUBLIC_BODY_MAX_LENGTH as BODY_MAX_LENGTH,
  PUBLIC_TITLE_MAX_LENGTH as TITLE_MAX_LENGTH,
  PUBLIC_REVIEW_DEGRADATION_NOTICE as DEGRADED_CAUTION,
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS,
  PUBLIC_API_ERROR_HTTP_STATUS,
  PUBLIC_IDEMPOTENCY_KEY_PATTERN,
} from "./types";

export type ArticleSegment = {
  key: string;
  text: string;
  findingId: string | null;
  highlight: boolean;
};

export type ResultPresentation = {
  kind: "findings" | "empty-success" | "degraded" | "failed" | "expired" | "cancelled" | "pending";
  caution: boolean;
  title: string;
  detail: string;
};

const USER_ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: "提交内容不完整或格式不正确，请检查后重试。",
  AUTH_REQUIRED: "登录状态已失效，请重新发起审校。",
  FORBIDDEN: "你无权访问这篇稿件。",
  REVIEW_NOT_FOUND: "找不到这篇审校任务，请重新提交。",
  FINDING_NOT_FOUND: "找不到这条审校意见，请刷新后重试。",
  VERSION_CONFLICT: "稿件已更新，请刷新结果后再操作。",
  REVIEW_ALREADY_RUNNING: "已有审校任务正在运行，请稍后再试。",
  IDEMPOTENCY_CONFLICT: "重复请求冲突，请稍后重试。",
  PRIVACY_NOTICE_OUTDATED: "隐私说明已更新，请重新确认后再提交。",
  ARTICLE_TOO_LARGE: "稿件超过 10,000 字，请缩短后重试。",
  CONTENT_REJECTED: "稿件未通过内容安全检查，无法提交。",
  DAILY_QUOTA_EXCEEDED: "今日审校额度已用完，请明天再试。",
  RATE_LIMITED: "请求过于频繁，请稍后再试。",
  REVIEW_CAPACITY_EXHAUSTED: "审校服务当前繁忙，请稍后再试。",
  UPSTREAM_UNAVAILABLE: "审校服务暂时不可用，请稍后再试。",
  NOT_IMPLEMENTED: "当前能力尚未开放。",
  INTERNAL_ERROR: "服务出现异常，请稍后再试。",
  NETWORK_UNAVAILABLE: "网络连接失败，请检查网络后重试。",
  TIMEOUT: "审校请求超时，不能视为稿件没有问题。",
  EMPTY_RESPONSE: "审校服务返回空结果，不能视为稿件没有问题。",
  CONFIG_REQUIRED: "尚未配置真实 API 域名，当前只能使用 fixture 模式。",
};

export function validateReviewInput(title: string, body: string): string | null {
  if (!title.trim()) {
    return "请填写稿件标题。";
  }
  if (!body.trim()) {
    return "请粘贴需要审校的正文。";
  }
  if (isPublicArticleTooLarge(title, body)) {
    if (utf16Length(title) > PUBLIC_TITLE_MAX_LENGTH) {
      return `标题不能超过 ${PUBLIC_TITLE_MAX_LENGTH} 字。`;
    }
    return `正文不能超过 ${PUBLIC_BODY_MAX_LENGTH} 字。`;
  }
  return null;
}

export function toUserError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: USER_ERROR_MESSAGES[error.code] ?? "请求失败，请稍后再试。",
    };
  }
  return { code: "UNKNOWN", message: "出现未知错误，请稍后再试。" };
}

export function isTerminalReviewStatus(status: ReviewStatus): boolean {
  return (
    status === "succeeded" ||
    status === "degraded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

export function hasDegradedResult(review: ReviewResource): boolean {
  return review.status === "degraded" || Boolean(review.degradation_notice);
}

export function resultPresentation(review: ReviewResource): ResultPresentation {
  if (review.status === "queued" || review.status === "running") {
    return {
      kind: "pending",
      caution: false,
      title: review.status === "queued" ? "已加入审校队列" : "正在审校稿件",
      detail: "请稍候，不要把等待过程当成审校已通过。",
    };
  }
  if (review.status === "failed") {
    return {
      kind: "failed",
      caution: true,
      title: "审校未完成",
      detail: "审校任务失败，不能视为稿件没有问题。",
    };
  }
  if (review.status === "expired") {
    return {
      kind: "expired",
      caution: true,
      title: "审校已过期",
      detail: "任务已过期，不能视为稿件没有问题。请重新提交。",
    };
  }
  if (review.status === "cancelled") {
    return {
      kind: "cancelled",
      caution: true,
      title: "审校已取消",
      detail: "任务已取消，没有完整审校结论。",
    };
  }
  if (hasDegradedResult(review)) {
    return {
      kind: "degraded",
      caution: true,
      title: "本轮结果不完整",
      detail: review.degradation_notice ?? PUBLIC_REVIEW_DEGRADATION_NOTICE,
    };
  }
  if (review.findings.length === 0) {
    return {
      kind: "empty-success",
      caution: false,
      title: "本轮未发现待处理问题",
      detail: "自动审校不能替代人工复核，仍建议通读全文。",
    };
  }
  return {
    kind: "findings",
    caution: false,
    title: "",
    detail: "",
  };
}

export function buildArticleSegments(body: string, findings: ReviewFinding[]): ArticleSegment[] {
  const spans = findings
    .filter(
      (finding) =>
        finding.source_span.field === "body" &&
        finding.source_span.start_offset >= 0 &&
        finding.source_span.end_offset > finding.source_span.start_offset &&
        finding.source_span.end_offset <= body.length,
    )
    .sort((left, right) => left.source_span.start_offset - right.source_span.start_offset);

  const result: ArticleSegment[] = [];
  let cursor = 0;
  for (const finding of spans) {
    const start = Math.max(cursor, finding.source_span.start_offset);
    const end = finding.source_span.end_offset;
    if (start >= end) {
      continue;
    }
    if (start > cursor) {
      result.push({
        key: `text-${cursor}`,
        text: body.slice(cursor, start),
        findingId: null,
        highlight: false,
      });
    }
    result.push({
      key: `finding-${finding.finding_id}`,
      text: body.slice(start, end),
      findingId: finding.finding_id,
      highlight: finding.status === "pending" || finding.status === "verify",
    });
    cursor = end;
  }
  if (cursor < body.length || result.length === 0) {
    result.push({
      key: `text-${cursor}`,
      text: body.slice(cursor),
      findingId: null,
      highlight: false,
    });
  }
  return result;
}

export function createActionId(): string {
  return `action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return key;
}

export function isPublicIdempotencyKey(value: string): boolean {
  return PUBLIC_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function defaultErrorCode(status: number): PublicApiErrorCode {
  switch (status) {
    case PUBLIC_API_ERROR_HTTP_STATUS.INVALID_REQUEST:
      return "INVALID_REQUEST";
    case PUBLIC_API_ERROR_HTTP_STATUS.AUTH_REQUIRED:
      return "AUTH_REQUIRED";
    case PUBLIC_API_ERROR_HTTP_STATUS.FORBIDDEN:
      return "FORBIDDEN";
    case PUBLIC_API_ERROR_HTTP_STATUS.REVIEW_NOT_FOUND:
      return "REVIEW_NOT_FOUND";
    case PUBLIC_API_ERROR_HTTP_STATUS.VERSION_CONFLICT:
      return "VERSION_CONFLICT";
    case PUBLIC_API_ERROR_HTTP_STATUS.ARTICLE_TOO_LARGE:
      return "ARTICLE_TOO_LARGE";
    case PUBLIC_API_ERROR_HTTP_STATUS.CONTENT_REJECTED:
      return "CONTENT_REJECTED";
    case PUBLIC_API_ERROR_HTTP_STATUS.RATE_LIMITED:
      return "RATE_LIMITED";
    case PUBLIC_API_ERROR_HTTP_STATUS.UPSTREAM_UNAVAILABLE:
      return "UPSTREAM_UNAVAILABLE";
    default:
      return "INTERNAL_ERROR";
  }
}

export function utf16Length(value: string): number {
  return value.length;
}

export function isPublicArticleTooLarge(title: string, body: string): boolean {
  return (
    utf16Length(title) > PUBLIC_TITLE_MAX_LENGTH ||
    utf16Length(body) > PUBLIC_BODY_MAX_LENGTH
  );
}

export function isEmptyResponseBody(data: unknown): boolean {
  if (data == null) {
    return true;
  }
  if (typeof data === "string") {
    return data.trim() === "";
  }
  if (typeof data === "object") {
    return Object.keys(data as Record<string, unknown>).length === 0;
  }
  return false;
}

export function parseApiError(status: number, data: unknown): ApiError {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === "object") {
      const error = nested as Record<string, unknown>;
      const code = typeof error.code === "string" ? error.code : defaultErrorCode(status);
      const message = typeof error.message === "string" ? error.message : "Request failed";
      return new ApiError(status, code, message);
    }
    if (typeof record.code === "string") {
      const message =
        typeof record.message === "string"
          ? record.message
          : typeof record.error === "string"
            ? record.error
            : "Request failed";
      return new ApiError(status, record.code, message);
    }
  }
  return new ApiError(status, defaultErrorCode(status), "Request failed");
}

export function progressCopy(status: ReviewStatus): { title: string; detail: string } {
  if (status === "queued") {
    return {
      title: "已加入审校队列",
      detail: "任务已创建，正在等待执行。等待期间不能视为稿件没有问题。",
    };
  }
  return {
    title: "正在审校稿件",
    detail: "模型审校进行中，请稍候。未完成前不能视为稿件没有问题。",
  };
}
