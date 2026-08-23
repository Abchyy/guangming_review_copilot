import type Database from "better-sqlite3";

import {
  ReviewDomainError,
  createReviewResponseSchema,
  findingSchema,
  pipelineMetadataSchema,
  type CreateReviewResponse,
  type Finding,
  type FindingAction,
  type FindingStatus,
} from "@grc/contracts";
import { canTransition } from "./domain";
import { applyReplacement, rebaseFindingsAfterAccept } from "./span-rebase";
import { fieldText } from "./article-text";

type ReviewRow = {
  review_id: string;
  article_id: string;
  original_title: string;
  original_body: string;
  current_title: string;
  current_body: string;
  article_version: number;
  findings_json: string;
  pipeline_json: string;
  created_at: string;
  updated_at: string;
};

type ActionRow = {
  action_id: string;
  review_id: string;
  finding_id: string;
  action: string;
  from_article_version: number;
  to_article_version: number;
  replaced_text: string | null;
  replacement: string | null;
  timestamp: string;
};

export type ApplyDecisionInput = {
  reviewId: string;
  findingId: string;
  action: FindingAction;
  expectedArticleVersion: number;
  actionId: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function snapshotFromRow(row: ReviewRow): CreateReviewResponse {
  return createReviewResponseSchema.parse({
    review_id: row.review_id,
    article: {
      title: row.current_title,
      body: row.current_body,
      version: row.article_version,
    },
    findings: JSON.parse(row.findings_json) as Finding[],
    pipeline: pipelineMetadataSchema.parse(JSON.parse(row.pipeline_json)),
  });
}

export class ReviewStore {
  constructor(private readonly db: Database.Database) {}

  insertCreatedReview(snapshot: CreateReviewResponse, original: {
    title: string;
    body: string;
  }): void {
    const timestamp = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO reviews (
            review_id, article_id, original_title, original_body,
            current_title, current_body, article_version,
            findings_json, pipeline_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.review_id,
          crypto.randomUUID(),
          original.title,
          original.body,
          snapshot.article.title,
          snapshot.article.body,
          snapshot.article.version,
          JSON.stringify(snapshot.findings),
          JSON.stringify(snapshot.pipeline),
          timestamp,
          timestamp,
        );
    } catch {
      throw new ReviewDomainError(503, "STORAGE_FAILURE", "Failed to persist review");
    }
  }

  getReview(reviewId: string): CreateReviewResponse {
    const row = this.getRow(reviewId);
    if (!row) {
      throw new ReviewDomainError(404, "REVIEW_NOT_FOUND", "Review not found");
    }
    return snapshotFromRow(row);
  }

  getAction(actionId: string): ActionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM review_actions WHERE action_id = ?`)
      .get(actionId) as ActionRow | undefined;
  }

  applyDecision(input: ApplyDecisionInput): CreateReviewResponse {
    try {
      return this.db.transaction(() => this.applyDecisionInsideTransaction(input))();
    } catch (error) {
      if (error instanceof ReviewDomainError) {
        throw error;
      }
      if (isUniqueConstraint(error)) {
        const existing = this.getAction(input.actionId);
        if (existing) {
          const samePayload =
            existing.review_id === input.reviewId &&
            existing.finding_id === input.findingId &&
            existing.action === input.action &&
            existing.from_article_version === input.expectedArticleVersion;
          if (samePayload) {
            return this.getReview(input.reviewId);
          }
          throw new ReviewDomainError(
            409,
            "ACTION_CONFLICT",
            "action_id already used with a different payload",
          );
        }
      }
      throw new ReviewDomainError(503, "STORAGE_FAILURE", "Failed to persist decision");
    }
  }

  private applyDecisionInsideTransaction(input: ApplyDecisionInput): CreateReviewResponse {
    const existingAction = this.getAction(input.actionId);
    if (existingAction) {
      const samePayload =
        existingAction.review_id === input.reviewId &&
        existingAction.finding_id === input.findingId &&
        existingAction.action === input.action &&
        existingAction.from_article_version === input.expectedArticleVersion;
      if (samePayload) {
        return this.getReview(input.reviewId);
      }
      throw new ReviewDomainError(
        409,
        "ACTION_CONFLICT",
        "action_id already used with a different payload",
      );
    }

    const row = this.getRow(input.reviewId);
    if (!row) {
      throw new ReviewDomainError(404, "REVIEW_NOT_FOUND", "Review not found");
    }

    const snapshot = snapshotFromRow(row);
    const finding = snapshot.findings.find((item) => item.finding_id === input.findingId);
    if (!finding) {
      throw new ReviewDomainError(404, "FINDING_NOT_FOUND", "Finding not found");
    }

    if (finding.status === "invalidated") {
      throw new ReviewDomainError(422, "FINDING_INVALIDATED", "Finding has been invalidated");
    }
    if (!canTransition(finding.status, input.action)) {
      throw new ReviewDomainError(
        422,
        "INVALID_STATUS_TRANSITION",
        `Cannot ${input.action} a ${finding.status} finding`,
      );
    }

    if (input.action === "accept") {
      return this.applyAccept(row, snapshot, finding, input);
    }

    return this.applyNonMutatingAction(row, snapshot, finding, input);
  }

  private applyAccept(
    row: ReviewRow,
    snapshot: CreateReviewResponse,
    finding: Finding,
    input: ApplyDecisionInput,
  ): CreateReviewResponse {
    if (input.expectedArticleVersion !== snapshot.article.version) {
      throw new ReviewDomainError(409, "STALE_ARTICLE", "Article version mismatch");
    }

    const replacement = finding.suggestion.replacement;
    if (replacement == null) {
      throw new ReviewDomainError(
        422,
        "NO_SAFE_REPLACEMENT",
        "Finding has no safe automatic replacement",
      );
    }

    const currentText = fieldText(snapshot.article, finding.source_span.field);
    const sliced = currentText.slice(
      finding.source_span.start_offset,
      finding.source_span.end_offset,
    );
    if (sliced !== finding.source_span.quoted_text) {
      throw new ReviewDomainError(409, "SPAN_MISMATCH", "Source span no longer matches article");
    }

    const nextArticle = applyReplacement(snapshot.article, finding.source_span, replacement);
    const nextFindings = rebaseFindingsAfterAccept({
      article: nextArticle,
      findings: snapshot.findings,
      acceptedFindingId: finding.finding_id,
      edit: {
        field: finding.source_span.field,
        start: finding.source_span.start_offset,
        end: finding.source_span.end_offset,
        replacementLength: replacement.length,
      },
    }).map((item) => findingSchema.parse(item));

    const nextSnapshot: CreateReviewResponse = {
      ...snapshot,
      article: nextArticle,
      findings: nextFindings,
    };

    this.persistSnapshot(row, nextSnapshot);
    this.insertAction({
      action_id: input.actionId,
      review_id: input.reviewId,
      finding_id: input.findingId,
      action: "accept",
      from_article_version: snapshot.article.version,
      to_article_version: nextArticle.version,
      replaced_text: finding.source_span.quoted_text,
      replacement,
    });
    return nextSnapshot;
  }

  private applyNonMutatingAction(
    row: ReviewRow,
    snapshot: CreateReviewResponse,
    finding: Finding,
    input: ApplyDecisionInput,
  ): CreateReviewResponse {
    const nextStatus: FindingStatus = input.action === "ignore" ? "ignored" : "verify";
    const nextFindings = snapshot.findings.map((item) =>
      item.finding_id === finding.finding_id ? { ...item, status: nextStatus } : item,
    );
    const nextSnapshot: CreateReviewResponse = {
      ...snapshot,
      findings: nextFindings,
    };
    this.persistSnapshot(row, nextSnapshot);
    this.insertAction({
      action_id: input.actionId,
      review_id: input.reviewId,
      finding_id: input.findingId,
      action: input.action,
      from_article_version: snapshot.article.version,
      to_article_version: snapshot.article.version,
      replaced_text: null,
      replacement: null,
    });
    return nextSnapshot;
  }

  private persistSnapshot(row: ReviewRow, snapshot: CreateReviewResponse): void {
    this.db
      .prepare(
        `UPDATE reviews
         SET current_title = ?, current_body = ?, article_version = ?,
             findings_json = ?, updated_at = ?
         WHERE review_id = ?`,
      )
      .run(
        snapshot.article.title,
        snapshot.article.body,
        snapshot.article.version,
        JSON.stringify(snapshot.findings),
        nowIso(),
        row.review_id,
      );
  }

  private insertAction(action: {
    action_id: string;
    review_id: string;
    finding_id: string;
    action: FindingAction;
    from_article_version: number;
    to_article_version: number;
    replaced_text: string | null;
    replacement: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_actions (
          action_id, review_id, finding_id, action,
          from_article_version, to_article_version,
          replaced_text, replacement, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.action_id,
        action.review_id,
        action.finding_id,
        action.action,
        action.from_article_version,
        action.to_article_version,
        action.replaced_text,
        action.replacement,
        nowIso(),
      );
  }

  private getRow(reviewId: string): ReviewRow | undefined {
    return this.db.prepare(`SELECT * FROM reviews WHERE review_id = ?`).get(reviewId) as
      | ReviewRow
      | undefined;
  }
}
