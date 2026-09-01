import { randomUUID } from "node:crypto";

import { PUBLIC_PRIVACY_NOTICE_VERSION } from "@grc/contracts";

import {
  NotImplementedPublicReviewJobStore,
  NotImplementedPublicReviewWorker,
  NotImplementedPublicSessionStore,
  NotImplementedWechatIdentityProvider,
} from "./fail-closed";
import {
  FixtureInlineReviewWorker,
  FixtureWechatIdentityProvider,
  InMemoryPublicReviewJobStore,
  InMemoryPublicSessionStore,
} from "./in-memory";
import { logPublicApiEvent } from "./log";
import type { PublicApiRuntime } from "./types";

export const FIXTURE_WECHAT_CODES = {
  userA: "fixture-code-a",
  userB: "fixture-code-b",
} as const;

const FIXTURE_WECHAT_SUBJECTS: Readonly<Record<string, string>> = {
  [FIXTURE_WECHAT_CODES.userA]: "fixture-subject-a",
  [FIXTURE_WECHAT_CODES.userB]: "fixture-subject-b",
};

export function createFixturePublicApiRuntime(
  options: {
    privacyNoticeVersion?: string;
    dailyLimit?: number;
    runningLimit?: number;
    createRequestId?: () => string;
    log?: PublicApiRuntime["log"];
  } = {},
): PublicApiRuntime {
  const reviews = new InMemoryPublicReviewJobStore({
    privacyNoticeVersion: options.privacyNoticeVersion ?? PUBLIC_PRIVACY_NOTICE_VERSION,
    dailyLimit: options.dailyLimit,
    runningLimit: options.runningLimit,
  });
  return {
    identityProvider: new FixtureWechatIdentityProvider(FIXTURE_WECHAT_SUBJECTS, {
      allowAnonymousFixtureCodes: true,
    }),
    sessions: new InMemoryPublicSessionStore(),
    reviews,
    worker: new FixtureInlineReviewWorker(reviews),
    privacyNoticeVersion: options.privacyNoticeVersion ?? PUBLIC_PRIVACY_NOTICE_VERSION,
    createRequestId: options.createRequestId ?? (() => randomUUID()),
    log: options.log ?? logPublicApiEvent,
  };
}

export function createFailClosedPublicApiRuntime(
  options: {
    createRequestId?: () => string;
    log?: PublicApiRuntime["log"];
  } = {},
): PublicApiRuntime {
  return {
    identityProvider: new NotImplementedWechatIdentityProvider(),
    sessions: new NotImplementedPublicSessionStore(),
    reviews: new NotImplementedPublicReviewJobStore(),
    worker: new NotImplementedPublicReviewWorker(),
    privacyNoticeVersion: PUBLIC_PRIVACY_NOTICE_VERSION,
    createRequestId: options.createRequestId ?? (() => randomUUID()),
    log: options.log ?? logPublicApiEvent,
  };
}

export function createPublicApiRuntimeFromEnv(): PublicApiRuntime {
  if (process.env.NODE_ENV === "production" || process.env.PUBLIC_API_MODE === "production") {
    return createFailClosedPublicApiRuntime();
  }
  return createFixturePublicApiRuntime();
}

let runtime: PublicApiRuntime | undefined;
let testOverride: PublicApiRuntime | undefined;

export function getPublicApiRuntime(): PublicApiRuntime {
  if (testOverride) return testOverride;
  if (!runtime) runtime = createPublicApiRuntimeFromEnv();
  return runtime;
}

export function setPublicApiRuntimeForTests(next: PublicApiRuntime | undefined): void {
  testOverride = next;
}

export function resetPublicApiRuntimeForTests(): void {
  testOverride = undefined;
  runtime = undefined;
}
