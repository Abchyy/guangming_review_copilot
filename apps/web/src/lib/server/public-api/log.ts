import { createHash } from "node:crypto";

import type { PublicApiLogEvent } from "./types";

export function publicUserKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

export function logPublicApiEvent(event: PublicApiLogEvent): void {
  console.info("[public-api]", {
    request_id: event.request_id,
    route: event.route,
    method: event.method,
    status: event.status,
    error_code: event.error_code ?? null,
    review_id: event.review_id ?? null,
    user_key: event.user_key ?? null,
  });
}
