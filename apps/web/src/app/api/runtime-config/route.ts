import { z } from "zod";

import { RUNTIME_KEY_MAX_LENGTH } from "@/lib/runtime-config";
import {
  attachRuntimeSessionCookie,
  ensureRuntimeSessionId,
} from "@/lib/server/runtime-session-cookie";
import { getRuntimeSessionStore } from "@/lib/server/runtime-session-store";
import {
  resolveRuntimeSecrets,
  toRuntimeConfigStatus,
} from "@/lib/server/runtime-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const runtimeConfigWriteSchema = z
  .object({
    deepseekApiKey: z.string().max(RUNTIME_KEY_MAX_LENGTH).optional(),
    tavilyApiKey: z.string().max(RUNTIME_KEY_MAX_LENGTH).optional(),
  })
  .strict();

function statusResponse(
  store: ReturnType<typeof getRuntimeSessionStore>,
  sessionId: string,
  created: boolean,
): Response {
  const stored = store.get(sessionId);
  const status = toRuntimeConfigStatus(
    resolveRuntimeSecrets(
      stored
        ? { deepseekApiKey: stored.deepseekApiKey, tavilyApiKey: stored.tavilyApiKey }
        : undefined,
    ),
  );
  return attachRuntimeSessionCookie(Response.json(status), sessionId, created);
}

export function createRuntimeConfigHandlers(
  store = getRuntimeSessionStore(),
) {
  return {
    GET(request: Request): Response {
      const { sessionId, created } = ensureRuntimeSessionId(request);
      if (created) {
        store.put(sessionId);
      }
      return statusResponse(store, sessionId, created);
    },
    async POST(request: Request): Promise<Response> {
      let json: unknown;
      try {
        json = await request.json();
      } catch {
        return Response.json({ error: "Request body must be JSON" }, { status: 400 });
      }

      const parsed = runtimeConfigWriteSchema.safeParse(json);
      if (!parsed.success) {
        return Response.json({ error: "Invalid runtime configuration" }, { status: 400 });
      }

      const { sessionId, created } = ensureRuntimeSessionId(request);
      const patch: { deepseekApiKey?: string | null; tavilyApiKey?: string | null } = {};
      if (Object.hasOwn(parsed.data, "deepseekApiKey")) {
        const value = parsed.data.deepseekApiKey?.trim() ?? "";
        patch.deepseekApiKey = value.length > 0 ? value : null;
      }
      if (Object.hasOwn(parsed.data, "tavilyApiKey")) {
        const value = parsed.data.tavilyApiKey?.trim() ?? "";
        patch.tavilyApiKey = value.length > 0 ? value : null;
      }
      store.put(sessionId, patch);
      return statusResponse(store, sessionId, created);
    },
  };
}

const handlers = createRuntimeConfigHandlers();

export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
