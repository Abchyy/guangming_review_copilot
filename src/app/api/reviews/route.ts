import {
  ReviewProviderError,
  ReviewRequestError,
  createReviewRequestSchema,
} from "@/lib/contracts/review";
import { createReviewModelFromEnv } from "@/lib/server/llm/create-review-model";
import type { ReviewModel } from "@/lib/server/llm/review-model";
import { createReview } from "@/lib/server/review-service";

export const maxDuration = 60;

export function createReviewPostHandler(model: ReviewModel) {
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
      const result = await createReview(parsed.data, model);
      return Response.json(result);
    } catch (error) {
      if (error instanceof ReviewRequestError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof ReviewProviderError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json({ error: "Internal review error" }, { status: 500 });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  return createReviewPostHandler(createReviewModelFromEnv())(request);
}
