import { handleCreateReview } from "@/lib/server/public-api/handlers";
import { getPublicApiRuntime } from "@/lib/server/public-api/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return handleCreateReview(getPublicApiRuntime())(request);
}
