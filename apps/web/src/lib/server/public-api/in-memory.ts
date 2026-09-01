import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
  PUBLIC_REVIEW_DEGRADATION_NOTICE,
  findingSchema,
  publicReviewResourceSchema,
  type Finding,
  type PublicCreateReviewRequest,
  type PublicFindingDecisionRequest,
  type PublicReviewResource,
} from "@grc/contracts";
import {
  applyReplacement,
  canTransition,
  fieldText,
  rebaseFindingsAfterAccept,
} from "@grc/review-store";

import { PublicApiError } from "./errors";
import {
  buildFixtureFindings,
  readFixtureDirective,
} from "./fixture-findings";
import type {
  CreatedSession,
  PublicPrincipal,
  PublicQuotaSnapshot,
  PublicReviewJobStore,
  PublicReviewWorker,
  PublicSessionStore,
  WechatIdentity,
  WechatIdentityProvider,
} from "./types";

type Clock = () => Date;

const ANONYMOUS_FIXTURE_CODE = /^fixture_[A-Za-z0-9_-]{8,128}$/;

function addMilliseconds(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fingerprintOf(value: unknown): string {
  return JSON.stringify(value);
}

export class FixtureWechatIdentityProvider implements WechatIdentityProvider {
  private readonly consumedCodes = new Set<string>();

  constructor(
    private readonly identities: Readonly<Record<string, string>>,
    private readonly options: { allowAnonymousFixtureCodes?: boolean } = {},
  ) {}

  async exchangeCode(code: string): Promise<WechatIdentity> {
    if (this.consumedCodes.has(code)) {
      throw new PublicApiError("INVALID_REQUEST", "Invalid or already used login code");
    }

    const knownSubject = this.identities[code];
    if (knownSubject) {
      this.consumedCodes.add(code);
      return { providerSubject: knownSubject };
    }

    if (this.options.allowAnonymousFixtureCodes !== false && ANONYMOUS_FIXTURE_CODE.test(code)) {
      this.consumedCodes.add(code);
      return { providerSubject: `anon_${code}` };
    }

    throw new PublicApiError("INVALID_REQUEST", "Invalid or already used login code");
  }
}

export class InMemoryPublicSessionStore implements PublicSessionStore {
  private readonly usersByProviderSubject = new Map<string, string>();
  private readonly sessionsByTokenHash = new Map<
    string,
    { principal: PublicPrincipal; expiresAtMs: number }
  >();

  constructor(
    private readonly options: {
      clock?: Clock;
      sessionTtlMs?: number;
      createToken?: () => string;
      createUserId?: () => string;
    } = {},
  ) {}

  async createSession(identity: WechatIdentity): Promise<CreatedSession> {
    const now = (this.options.clock ?? (() => new Date()))();
    let userId = this.usersByProviderSubject.get(identity.providerSubject);
    if (!userId) {
      userId = (this.options.createUserId ?? (() => `user_${randomUUID()}`))();
      this.usersByProviderSubject.set(identity.providerSubject, userId);
    }
    const token = (this.options.createToken ?? (() => randomBytes(32).toString("base64url")))();
    const expiresAtMs = now.getTime() + (this.options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000);
    const principal = { userId };
    this.sessionsByTokenHash.set(tokenHash(token), { principal, expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString(), principal };
  }

  async resolveSession(token: string): Promise<PublicPrincipal | null> {
    const stored = this.sessionsByTokenHash.get(tokenHash(token));
    if (!stored) return null;
    const now = (this.options.clock ?? (() => new Date()))();
    if (stored.expiresAtMs <= now.getTime()) {
      this.sessionsByTokenHash.delete(tokenHash(token));
      return null;
    }
    return stored.principal;
  }
}

type LiveReview = {
  deleted: false;
  ownerId: string;
  resource: PublicReviewResource;
};

type DeletedReview = {
  deleted: true;
  ownerId: string;
};

type StoredReview = LiveReview | DeletedReview;

type IdempotentRecord = {
  fingerprint: string;
  reviewId?: string;
  resource?: PublicReviewResource;
};

export class InMemoryPublicReviewJobStore implements PublicReviewJobStore {
  private readonly reviews = new Map<string, StoredReview>();
  private readonly createRequests = new Map<string, IdempotentRecord>();
  private readonly writeRequests = new Map<string, IdempotentRecord>();
  private readonly decisions = new Map<string, IdempotentRecord>();
  private readonly dailyUsage = new Map<string, number>();

  constructor(
    private readonly options: {
      privacyNoticeVersion: string;
      clock?: Clock;
      createReviewId?: () => string;
      dailyLimit?: number;
      runningLimit?: number;
      reviewTtlMs?: number;
      pollAfterMs?: number;
    },
  ) {}

  async quotaFor(ownerId: string): Promise<PublicQuotaSnapshot> {
    return {
      dailyLimit: this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.usedToday(ownerId)),
      runningLimit: this.runningLimit,
    };
  }

  async enqueueReview(input: {
    ownerId: string;
    idempotencyKey: string;
    review: PublicCreateReviewRequest;
  }) {
    if (input.review.privacy_notice_version !== this.options.privacyNoticeVersion) {
      throw new PublicApiError(
        "PRIVACY_NOTICE_OUTDATED",
        "The accepted privacy notice version is no longer current",
      );
    }

    if (readFixtureDirective(input.review.title, input.review.body) === "rejected") {
      throw new PublicApiError("CONTENT_REJECTED", "Article content was rejected");
    }

    const idempotencyScope = `${input.ownerId}:create:${input.idempotencyKey}`;
    const fingerprint = fingerprintOf(input.review);
    const existing = this.createRequests.get(idempotencyScope);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PublicApiError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with a different request",
        );
      }
      const stored = existing.reviewId ? this.reviews.get(existing.reviewId) : undefined;
      if (!stored || stored.deleted) {
        throw new PublicApiError("REVIEW_NOT_FOUND", "Review not found");
      }
      return this.enqueuedFrom(stored.resource);
    }

    const quota = await this.quotaFor(input.ownerId);
    if (quota.remaining === 0) {
      throw new PublicApiError("DAILY_QUOTA_EXCEEDED", "Daily review quota exceeded");
    }
    if (this.runningCount(input.ownerId) >= this.runningLimit) {
      throw new PublicApiError(
        "REVIEW_ALREADY_RUNNING",
        "Another review is already queued or running",
      );
    }

    const now = (this.options.clock ?? (() => new Date()))();
    const reviewId = (this.options.createReviewId ?? (() => `review_${randomUUID()}`))();
    const timestamp = now.toISOString();
    const resource = publicReviewResourceSchema.parse({
      review_id: reviewId,
      status: "queued",
      article: { title: input.review.title, body: input.review.body, version: 1 },
      findings: [],
      degradation_notice: null,
      failure_code: null,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: addMilliseconds(now, this.options.reviewTtlMs ?? 24 * 60 * 60 * 1000),
    });
    this.reviews.set(reviewId, { deleted: false, ownerId: input.ownerId, resource });
    this.createRequests.set(idempotencyScope, { fingerprint, reviewId });
    this.incrementUsage(input.ownerId, timestamp);
    return this.enqueuedFrom(resource);
  }

  async getOwnedReview(ownerId: string, reviewId: string): Promise<PublicReviewResource | null> {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted || stored.ownerId !== ownerId) return null;
    return structuredClone(stored.resource);
  }

  async deleteOwnedReview(
    ownerId: string,
    reviewId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const scope = `${ownerId}:delete:${idempotencyKey}`;
    const fingerprint = `DELETE:${reviewId}`;
    const existing = this.writeRequests.get(scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PublicApiError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with a different request",
        );
      }
      return true;
    }

    const stored = this.reviews.get(reviewId);
    if (!stored || stored.ownerId !== ownerId) return false;
    this.reviews.set(reviewId, { deleted: true, ownerId });
    this.writeRequests.set(scope, { fingerprint, reviewId });
    return true;
  }

  async decideFinding(input: {
    ownerId: string;
    reviewId: string;
    findingId: string;
    idempotencyKey: string;
    decision: PublicFindingDecisionRequest;
  }): Promise<PublicReviewResource> {
    const writeScope = `${input.ownerId}:decision:${input.idempotencyKey}`;
    const writeFingerprint = fingerprintOf({
      reviewId: input.reviewId,
      findingId: input.findingId,
      decision: input.decision,
    });
    const existingWrite = this.writeRequests.get(writeScope);
    if (existingWrite) {
      if (existingWrite.fingerprint !== writeFingerprint) {
        throw new PublicApiError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with a different request",
        );
      }
      if (existingWrite.resource) {
        return structuredClone(existingWrite.resource);
      }
    }

    const actionScope = `${input.ownerId}:action:${input.decision.action_id}`;
    const actionFingerprint = fingerprintOf({
      reviewId: input.reviewId,
      findingId: input.findingId,
      action: input.decision.action,
      expected_article_version: input.decision.expected_article_version,
    });
    const existingAction = this.decisions.get(actionScope);
    if (existingAction) {
      if (existingAction.fingerprint !== actionFingerprint) {
        throw new PublicApiError(
          "IDEMPOTENCY_CONFLICT",
          "action_id was already used with a different request",
        );
      }
      const replay = await this.requireLiveOwnedReview(input.ownerId, input.reviewId);
      this.writeRequests.set(writeScope, { fingerprint: writeFingerprint, resource: replay });
      return replay;
    }

    const stored = await this.requireLiveOwnedReview(input.ownerId, input.reviewId);
    if (stored.status === "queued" || stored.status === "running") {
      throw new PublicApiError(
        "REVIEW_ALREADY_RUNNING",
        "Review is still queued or running",
      );
    }
    if (stored.status !== "succeeded" && stored.status !== "degraded") {
      throw new PublicApiError("INVALID_REQUEST", "Review is not available for decisions");
    }

    const finding = stored.findings.find((item) => item.finding_id === input.findingId);
    if (!finding) {
      throw new PublicApiError("FINDING_NOT_FOUND", "Finding not found");
    }
    if (finding.status === "invalidated") {
      throw new PublicApiError("INVALID_REQUEST", "Finding has been invalidated");
    }
    if (!canTransition(finding.status, input.decision.action)) {
      throw new PublicApiError(
        "INVALID_REQUEST",
        `Cannot ${input.decision.action} a ${finding.status} finding`,
      );
    }

    const nextResource =
      input.decision.action === "accept"
        ? this.applyAccept(stored, finding, input.decision)
        : this.applyNonMutatingAction(stored, finding, input.decision);

    const live = this.reviews.get(input.reviewId);
    if (!live || live.deleted) {
      throw new PublicApiError("REVIEW_NOT_FOUND", "Review not found");
    }
    live.resource = nextResource;
    this.decisions.set(actionScope, { fingerprint: actionFingerprint, resource: nextResource });
    this.writeRequests.set(writeScope, { fingerprint: writeFingerprint, resource: nextResource });
    return structuredClone(nextResource);
  }

  applyFixtureOutcome(reviewId: string): void {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted) return;
    if (stored.resource.status !== "queued") return;
    const directive = readFixtureDirective(stored.resource.article.title, stored.resource.article.body);
    if (directive === "queued") return;
    if (directive === "running") {
      this.updateFixtureReview(reviewId, { status: "running" });
      return;
    }
    if (directive === "degraded") {
      this.updateFixtureReview(reviewId, {
        status: "degraded",
        findings: [],
        degradation_notice: PUBLIC_REVIEW_DEGRADATION_NOTICE,
        failure_code: null,
      });
      return;
    }
    if (directive === "failed") {
      this.updateFixtureReview(reviewId, {
        status: "failed",
        findings: [],
        degradation_notice: null,
        failure_code: "UPSTREAM_UNAVAILABLE",
      });
      return;
    }
    this.updateFixtureReview(reviewId, {
      status: "succeeded",
      findings: buildFixtureFindings(stored.resource.article),
      degradation_notice: null,
      failure_code: null,
    });
  }

  private applyAccept(
    stored: PublicReviewResource,
    finding: Finding,
    decision: PublicFindingDecisionRequest,
  ): PublicReviewResource {
    if (decision.expected_article_version !== stored.article.version) {
      throw new PublicApiError("VERSION_CONFLICT", "Article version mismatch");
    }
    const replacement = finding.suggestion.replacement;
    if (replacement == null) {
      throw new PublicApiError("INVALID_REQUEST", "Finding has no safe automatic replacement");
    }
    const currentText = fieldText(stored.article, finding.source_span.field);
    const sliced = currentText.slice(
      finding.source_span.start_offset,
      finding.source_span.end_offset,
    );
    if (sliced !== finding.source_span.quoted_text) {
      throw new PublicApiError("VERSION_CONFLICT", "Source span no longer matches article");
    }

    const nextArticle = applyReplacement(stored.article, finding.source_span, replacement);
    const nextFindings = rebaseFindingsAfterAccept({
      article: nextArticle,
      findings: stored.findings,
      acceptedFindingId: finding.finding_id,
      edit: {
        field: finding.source_span.field,
        start: finding.source_span.start_offset,
        end: finding.source_span.end_offset,
        replacementLength: replacement.length,
      },
    }).map((item) => findingSchema.parse(item));

    return this.withUpdatedResource(stored, {
      article: nextArticle,
      findings: nextFindings,
    });
  }

  private applyNonMutatingAction(
    stored: PublicReviewResource,
    finding: Finding,
    decision: PublicFindingDecisionRequest,
  ): PublicReviewResource {
    if (decision.expected_article_version !== stored.article.version) {
      throw new PublicApiError("VERSION_CONFLICT", "Article version mismatch");
    }
    const nextStatus = decision.action === "ignore" ? "ignored" : "verify";
    return this.withUpdatedResource(stored, {
      findings: stored.findings.map((item) =>
        item.finding_id === finding.finding_id ? { ...item, status: nextStatus } : item,
      ),
    });
  }

  private withUpdatedResource(
    stored: PublicReviewResource,
    patch: Partial<PublicReviewResource>,
  ): PublicReviewResource {
    const now = (this.options.clock ?? (() => new Date()))().toISOString();
    return publicReviewResourceSchema.parse({
      ...stored,
      ...patch,
      updated_at: now,
    });
  }

  private async requireLiveOwnedReview(
    ownerId: string,
    reviewId: string,
  ): Promise<PublicReviewResource> {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted || stored.ownerId !== ownerId) {
      throw new PublicApiError("REVIEW_NOT_FOUND", "Review not found");
    }
    return stored.resource;
  }

  private updateFixtureReview(reviewId: string, patch: Partial<PublicReviewResource>): void {
    const stored = this.reviews.get(reviewId);
    if (!stored || stored.deleted) {
      throw new Error(`Unknown fixture review: ${reviewId}`);
    }
    stored.resource = this.withUpdatedResource(stored.resource, patch);
  }

  private enqueuedFrom(resource: PublicReviewResource) {
    return {
      reviewId: resource.review_id,
      expiresAt: resource.expires_at,
      pollAfterMs: this.options.pollAfterMs ?? PUBLIC_DEFAULT_POLL_AFTER_MS,
    };
  }

  private usedToday(ownerId: string): number {
    return this.dailyUsage.get(this.usageKey(ownerId)) ?? 0;
  }

  private incrementUsage(ownerId: string, timestamp: string): void {
    const key = this.usageKey(ownerId, timestamp);
    this.dailyUsage.set(key, (this.dailyUsage.get(key) ?? 0) + 1);
  }

  private usageKey(ownerId: string, timestamp?: string): string {
    const now = timestamp ?? (this.options.clock ?? (() => new Date()))().toISOString();
    return `${ownerId}:${now.slice(0, 10)}`;
  }

  private runningCount(ownerId: string): number {
    let count = 0;
    for (const stored of this.reviews.values()) {
      if (
        !stored.deleted &&
        stored.ownerId === ownerId &&
        (stored.resource.status === "queued" || stored.resource.status === "running")
      ) {
        count += 1;
      }
    }
    return count;
  }

  private get dailyLimit(): number {
    return this.options.dailyLimit ?? PUBLIC_DEFAULT_DAILY_LIMIT;
  }

  private get runningLimit(): number {
    return this.options.runningLimit ?? PUBLIC_DEFAULT_RUNNING_LIMIT;
  }
}

export class FixtureInlineReviewWorker implements PublicReviewWorker {
  constructor(private readonly store: InMemoryPublicReviewJobStore) {}

  async processEnqueued(reviewId: string): Promise<void> {
    this.store.applyFixtureOutcome(reviewId);
  }
}

export function hasForbiddenControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
