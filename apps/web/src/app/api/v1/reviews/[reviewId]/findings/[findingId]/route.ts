import { handleFindingDecision } from "@/lib/server/public-api/handlers";
import { getPublicApiRuntime } from "@/lib/server/public-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ reviewId: string; findingId: string }> },
): Promise<Response> {
  return handleFindingDecision(getPublicApiRuntime())(request, context);
}
