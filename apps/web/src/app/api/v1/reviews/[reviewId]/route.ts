import { handleDeleteReview, handleGetReview } from "@/lib/server/public-api/handlers";
import { getPublicApiRuntime } from "@/lib/server/public-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  return handleGetReview(getPublicApiRuntime())(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  return handleDeleteReview(getPublicApiRuntime())(request, context);
}
