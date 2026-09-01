import {
  publicApiErrorResponseSchema,
  publicIdempotencyKeySchema,
} from "@grc/contracts";

import { PublicApiError } from "./errors";
import { publicUserKey } from "./log";
import type { PublicApiLogEvent, PublicApiRuntime, PublicPrincipal } from "./types";

export const REQUEST_ID_HEADER = "x-request-id";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function readRequestId(request: Request, createRequestId: () => string): string {
  const header = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (header && REQUEST_ID_PATTERN.test(header)) return header;
  return createRequestId();
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function readIdempotencyKey(request: Request): string {
  const value = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!value) {
    throw new PublicApiError("INVALID_REQUEST", "Idempotency-Key header is required");
  }
  const parsed = publicIdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new PublicApiError("INVALID_REQUEST", "Idempotency-Key must be a UUID");
  }
  return parsed.data;
}

export async function requirePrincipal(
  request: Request,
  runtime: PublicApiRuntime,
): Promise<PublicPrincipal> {
  const token = readBearerToken(request);
  if (!token) {
    throw new PublicApiError("AUTH_REQUIRED", "Authorization bearer token is required");
  }
  const principal = await runtime.sessions.resolveSession(token);
  if (!principal) {
    throw new PublicApiError("AUTH_REQUIRED", "Authorization bearer token is invalid");
  }
  return principal;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PublicApiError("INVALID_REQUEST", "Request body must be JSON");
  }
}

export function publicJson(
  status: number,
  requestId: string,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(body, {
    status,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...extraHeaders,
    },
  });
}

export function publicNoContent(requestId: string): Response {
  return new Response(null, {
    status: 204,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

export function publicError(requestId: string, error: PublicApiError): Response {
  const body = publicApiErrorResponseSchema.parse({
    request_id: requestId,
    error: {
      code: error.code,
      message: error.message,
    },
  });
  return publicJson(error.status, requestId, body);
}

export function toPublicError(error: unknown): PublicApiError {
  if (error instanceof PublicApiError) return error;
  return new PublicApiError("INTERNAL_ERROR", "Internal error");
}

export function logAndRespond(
  runtime: PublicApiRuntime,
  event: Omit<PublicApiLogEvent, "status" | "error_code"> & {
    response: Response;
    error?: PublicApiError;
    userId?: string;
  },
): Response {
  runtime.log({
    request_id: event.request_id,
    route: event.route,
    method: event.method,
    status: event.response.status,
    error_code: event.error?.code,
    review_id: event.review_id,
    user_key: event.userId ? publicUserKey(event.userId) : undefined,
  });
  return event.response;
}

export async function withPublicApi(
  request: Request,
  runtime: PublicApiRuntime,
  route: string,
  work: (input: { requestId: string }) => Promise<Response>,
): Promise<Response> {
  const requestId = readRequestId(request, runtime.createRequestId);
  try {
    const response = await work({ requestId });
    if (!response.headers.get(REQUEST_ID_HEADER)) {
      response.headers.set(REQUEST_ID_HEADER, requestId);
    }
    return logAndRespond(runtime, {
      request_id: requestId,
      route,
      method: request.method,
      response,
    });
  } catch (error) {
    const publicErrorValue = toPublicError(error);
    const response = publicError(requestId, publicErrorValue);
    return logAndRespond(runtime, {
      request_id: requestId,
      route,
      method: request.method,
      response,
      error: publicErrorValue,
    });
  }
}
