import {
  ReviewDomainError,
  ReviewProviderError,
  ReviewRequestError,
  createReviewRequestSchema,
} from "@grc/contracts";
import { createReviewModelFromEnv, LlmCandidateCache } from "@grc/providers";
import type { ReviewModel } from "@grc/providers";
import { createReview } from "@grc/review-core";
import { ReviewStore, getReviewDatabase } from "@grc/review-store";
import { getReviewStore } from "@/lib/server/store-singleton";

export const maxDuration = 60;

function errorResponse(error: unknown): Response {
  if (error instanceof ReviewRequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ReviewProviderError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ReviewDomainError) {
    return Response.json(
      { code: error.code, error: error.message },
      { status: error.status },
    );
  }
  return Response.json({ error: "Internal review error" }, { status: 500 });
}

export function createReviewPostHandler(
  model: ReviewModel,
  store: ReviewStore = getReviewStore(),
) {
  return async function POST(request: Request): Promise<Response> {
    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return Response.json(
        { error: "Request body must be JSON with title and body" },
        { status: 400 },
      );
    }

    const parsed = createReviewRequestSchema.safeParse(json);
    if (!parsed.success) {
      return Response.json(
        { error: "title and body are required strings" },
        { status: 400 },
      );
    }

    try {
      const result = await createReview(parsed.data, model, {
        useCache: model.provider !== "fixture",
        cache:
          model.provider !== "fixture"
            ? new LlmCandidateCache(getReviewDatabase())
            : null,
      });
      store.insertCreatedReview(result, {
        title: result.article.title,
        body: result.article.body,
      });
      return Response.json(result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  return createReviewPostHandler(createReviewModelFromEnv())(request);
}
