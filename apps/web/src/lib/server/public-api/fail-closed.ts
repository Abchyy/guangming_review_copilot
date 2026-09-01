import { PublicApiError } from "./errors";
import type {
  PublicReviewJobStore,
  PublicReviewWorker,
  PublicSessionStore,
  WechatIdentityProvider,
} from "./types";

function notImplemented(component: string): PublicApiError {
  return new PublicApiError(
    "NOT_IMPLEMENTED",
    `${component} is not configured`,
  );
}

export class NotImplementedWechatIdentityProvider implements WechatIdentityProvider {
  async exchangeCode(): Promise<never> {
    throw notImplemented("WeChat code2Session");
  }
}

export class NotImplementedPublicSessionStore implements PublicSessionStore {
  async createSession(): Promise<never> {
    throw notImplemented("Public session storage");
  }

  async resolveSession(): Promise<never> {
    throw notImplemented("Public session storage");
  }
}

export class NotImplementedPublicReviewJobStore implements PublicReviewJobStore {
  async quotaFor(): Promise<never> {
    throw notImplemented("Public review persistence");
  }

  async enqueueReview(): Promise<never> {
    throw notImplemented("Public review persistence");
  }

  async getOwnedReview(): Promise<never> {
    throw notImplemented("Public review persistence");
  }

  async deleteOwnedReview(): Promise<never> {
    throw notImplemented("Public review persistence");
  }

  async decideFinding(): Promise<never> {
    throw notImplemented("Public review persistence");
  }
}

export class NotImplementedPublicReviewWorker implements PublicReviewWorker {
  async processEnqueued(): Promise<never> {
    throw notImplemented("Public review worker");
  }
}
