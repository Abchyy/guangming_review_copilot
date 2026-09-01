import { createIdempotencyKey, isEmptyResponseBody, parseApiError } from "./contract";
import {
  ApiError,
  type CreateReviewInput,
  type CreateReviewResult,
  type DecisionInput,
  type GetReviewResult,
  type LoginResult,
  type ReviewClient,
} from "./types";

type AuthResponse = LoginResult & {
  session_token: string;
};

function getWx(): typeof wx {
  const runtime = globalThis as typeof globalThis & { wx?: typeof wx };
  if (!runtime.wx) {
    throw new ApiError(0, "CONFIG_REQUIRED", "wx runtime is unavailable");
  }
  return runtime.wx;
}

function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    getWx().login({
      timeout: 10_000,
      success: (result) => {
        if (result.code) {
          resolve(result.code);
          return;
        }
        reject(new ApiError(401, "AUTH_REQUIRED", "wx.login returned an empty code"));
      },
      fail: (error) => {
        reject(networkOrTimeoutError(error.errMsg));
      },
    });
  });
}

function networkOrTimeoutError(errMsg: string): ApiError {
  if (/timeout/i.test(errMsg)) {
    return new ApiError(0, "TIMEOUT", errMsg);
  }
  return new ApiError(0, "NETWORK_UNAVAILABLE", errMsg);
}

function request<T>(options: {
  url: string;
  method: WxRequestMethod;
  data?: unknown;
  headers?: Record<string, string>;
  allowEmpty?: boolean;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    getWx().request<T>({
      url: options.url,
      method: options.method,
      data: options.data,
      timeout: 15_000,
      header: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      success: (response) => {
        if (response.statusCode === 204) {
          resolve(undefined as T);
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (!options.allowEmpty && isEmptyResponseBody(response.data)) {
            reject(new ApiError(response.statusCode, "EMPTY_RESPONSE", "Empty response body"));
            return;
          }
          resolve(response.data as T);
          return;
        }
        reject(parseApiError(response.statusCode, response.data));
      },
      fail: (error) => {
        reject(networkOrTimeoutError(error.errMsg));
      },
    });
  });
}

function requireReviewEnvelope(data: GetReviewResult): GetReviewResult {
  const review = data?.review;
  if (!data?.request_id || !review || typeof review !== "object" || !review.review_id) {
    throw new ApiError(0, "EMPTY_RESPONSE", "Review payload was missing");
  }
  return data;
}

export class WechatApiClient implements ReviewClient {
  private readonly baseUrl: string;
  private sessionToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async login(): Promise<LoginResult> {
    if (!this.baseUrl || !this.baseUrl.startsWith("https://")) {
      throw new ApiError(0, "CONFIG_REQUIRED", "A real HTTPS API base URL is required");
    }
    const code = await wxLogin();
    const response = await request<AuthResponse>({
      url: `${this.baseUrl}/api/v1/auth/wechat`,
      method: "POST",
      data: { code },
    });
    if (!response?.session_token || !response.request_id) {
      throw new ApiError(0, "EMPTY_RESPONSE", "Login response was incomplete");
    }
    this.sessionToken = response.session_token;
    return {
      request_id: response.request_id,
      expires_at: response.expires_at,
      daily_limit: response.daily_limit,
      remaining: response.remaining,
      running_limit: response.running_limit,
    };
  }

  createReview(input: CreateReviewInput): Promise<CreateReviewResult> {
    return this.authorizedRequest<CreateReviewResult>("/api/v1/reviews", "POST", input, true);
  }

  async getReview(reviewId: string): Promise<GetReviewResult> {
    const data = await this.authorizedRequest<GetReviewResult>(`/api/v1/reviews/${reviewId}`, "GET");
    return requireReviewEnvelope(data);
  }

  async decide(
    reviewId: string,
    findingId: string,
    input: DecisionInput,
  ): Promise<GetReviewResult> {
    const data = await this.authorizedRequest<GetReviewResult>(
      `/api/v1/reviews/${reviewId}/findings/${findingId}`,
      "PATCH",
      input,
      true,
    );
    return requireReviewEnvelope(data);
  }

  async deleteReview(reviewId: string): Promise<void> {
    await this.authorizedRequest<unknown>(
      `/api/v1/reviews/${reviewId}`,
      "DELETE",
      undefined,
      true,
      true,
    );
  }

  private authorizedRequest<T>(
    path: string,
    method: WxRequestMethod,
    data?: unknown,
    idempotent = false,
    allowEmpty = false,
  ): Promise<T> {
    if (!this.sessionToken) {
      return Promise.reject(new ApiError(401, "AUTH_REQUIRED", "Session is missing"));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.sessionToken}`,
    };
    if (idempotent) {
      headers["Idempotency-Key"] = createIdempotencyKey();
    }
    return request<T>({
      url: `${this.baseUrl}${path}`,
      method,
      data,
      headers,
      allowEmpty,
    });
  }
}
