import type {
  PublicCreateReviewRequest,
  PublicFindingDecisionRequest,
  PublicReviewResource,
} from "@grc/contracts";

export type WechatIdentity = {
  providerSubject: string;
};

export interface WechatIdentityProvider {
  exchangeCode(code: string): Promise<WechatIdentity>;
}

export type PublicPrincipal = {
  userId: string;
};

export type CreatedSession = {
  token: string;
  expiresAt: string;
  principal: PublicPrincipal;
};

export interface PublicSessionStore {
  createSession(identity: WechatIdentity): Promise<CreatedSession>;
  resolveSession(token: string): Promise<PublicPrincipal | null>;
}

export type PublicQuotaSnapshot = {
  dailyLimit: number;
  remaining: number;
  runningLimit: number;
};

export type EnqueuedPublicReview = {
  reviewId: string;
  expiresAt: string;
  pollAfterMs: number;
};

export interface PublicReviewJobStore {
  quotaFor(ownerId: string): Promise<PublicQuotaSnapshot>;
  enqueueReview(input: {
    ownerId: string;
    idempotencyKey: string;
    review: PublicCreateReviewRequest;
  }): Promise<EnqueuedPublicReview>;
  getOwnedReview(ownerId: string, reviewId: string): Promise<PublicReviewResource | null>;
  deleteOwnedReview(
    ownerId: string,
    reviewId: string,
    idempotencyKey: string,
  ): Promise<boolean>;
  decideFinding(input: {
    ownerId: string;
    reviewId: string;
    findingId: string;
    idempotencyKey: string;
    decision: PublicFindingDecisionRequest;
  }): Promise<PublicReviewResource>;
}

export interface PublicReviewWorker {
  processEnqueued(reviewId: string): Promise<void>;
}

export type PublicApiLogEvent = {
  request_id: string;
  route: string;
  method: string;
  status: number;
  error_code?: string;
  review_id?: string;
  user_key?: string;
};

export type PublicApiRuntime = {
  identityProvider: WechatIdentityProvider;
  sessions: PublicSessionStore;
  reviews: PublicReviewJobStore;
  worker: PublicReviewWorker;
  privacyNoticeVersion: string;
  createRequestId: () => string;
  log: (event: PublicApiLogEvent) => void;
};
