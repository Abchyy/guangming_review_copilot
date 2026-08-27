import { RUNTIME_SESSION_COOKIE } from "@/lib/runtime-config";

export const RUNTIME_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createRuntimeSessionId(): string {
  return crypto.randomUUID();
}

export function readRuntimeSessionId(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (trimmed.slice(0, separator) !== RUNTIME_SESSION_COOKIE) {
      continue;
    }
    let value = trimmed.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return undefined;
    }
    if (RUNTIME_SESSION_ID_PATTERN.test(value)) {
      return value;
    }
    return undefined;
  }
  return undefined;
}

export function serializeRuntimeSessionCookie(sessionId: string): string {
  const parts = [
    `${RUNTIME_SESSION_COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function ensureRuntimeSessionId(request: Request): {
  sessionId: string;
  created: boolean;
} {
  const existing = readRuntimeSessionId(request);
  if (existing) {
    return { sessionId: existing, created: false };
  }
  return { sessionId: createRuntimeSessionId(), created: true };
}

export function attachRuntimeSessionCookie(
  response: Response,
  sessionId: string,
  created: boolean,
): Response {
  if (created) {
    response.headers.append("Set-Cookie", serializeRuntimeSessionCookie(sessionId));
  }
  return response;
}
