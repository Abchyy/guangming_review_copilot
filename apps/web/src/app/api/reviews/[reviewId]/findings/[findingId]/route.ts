import {
  ReviewDomainError,
  findingDecisionRequestSchema,
} from "@grc/contracts";
import { ReviewStore } from "@grc/review-store";
import { getReviewStore } from "@/lib/server/store-singleton";

export const maxDuration = 60;

export function createFindingPatchHandler(store: ReviewStore = getReviewStore()) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ reviewId: string; findingId: string }> },
  ): Promise<Response> {
    const { reviewId, findingId } = await context.params;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json(
        { code: "INVALID_STATUS_TRANSITION", error: "Request body must be JSON" },
        { status: 400 },
      );
    }

    const parsed = findingDecisionRequestSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json(
        {
          code: "INVALID_STATUS_TRANSITION",
          error: "action, expected_article_version, and action_id are required",
        },
        { status: 400 },
      );
    }

    try {
      const result = store.applyDecision({
        reviewId,
        findingId,
        action: parsed.data.action,
        expectedArticleVersion: parsed.data.expected_article_version,
        actionId: parsed.data.action_id,
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof ReviewDomainError) {
        return Response.json(
          { code: error.code, error: error.message },
          { status: error.status },
        );
      }
      return Response.json({ error: "Internal review error" }, { status: 500 });
    }
  };
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ reviewId: string; findingId: string }> },
): Promise<Response> {
  return createFindingPatchHandler()(request, context);
}
