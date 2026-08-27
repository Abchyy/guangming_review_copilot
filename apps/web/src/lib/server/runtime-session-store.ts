import { inspect } from "node:util";

import { RUNTIME_KEY_MAX_LENGTH } from "@/lib/runtime-config";

export const MAX_RUNTIME_SESSIONS = 2048;

function normalizeStoredKey(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > RUNTIME_KEY_MAX_LENGTH) {
    return undefined;
  }
  return trimmed;
}

export class RuntimeSessionSecrets {
  readonly #deepseekApiKey: string | undefined;
  readonly #tavilyApiKey: string | undefined;

  constructor(keys: { deepseekApiKey?: string; tavilyApiKey?: string } = {}) {
    this.#deepseekApiKey = normalizeStoredKey(keys.deepseekApiKey);
    this.#tavilyApiKey = normalizeStoredKey(keys.tavilyApiKey);
  }

  get deepseekApiKey(): string | undefined {
    return this.#deepseekApiKey;
  }

  get tavilyApiKey(): string | undefined {
    return this.#tavilyApiKey;
  }

  toJSON(): { deepseek: boolean; tavily: boolean } {
    return {
      deepseek: Boolean(this.#deepseekApiKey),
      tavily: Boolean(this.#tavilyApiKey),
    };
  }

  [inspect.custom](): string {
    return `RuntimeSessionSecrets { deepseek: ${this.#deepseekApiKey ? "set" : "missing"}, tavily: ${this.#tavilyApiKey ? "set" : "missing"} }`;
  }
}

export type RuntimeSessionKeyPatch = {
  deepseekApiKey?: string | null;
  tavilyApiKey?: string | null;
};

export class RuntimeSessionStore {
  readonly #sessions = new Map<string, RuntimeSessionSecrets>();

  get size(): number {
    return this.#sessions.size;
  }

  get(sessionId: string): RuntimeSessionSecrets | undefined {
    return this.#sessions.get(sessionId);
  }

  put(sessionId: string, patch: RuntimeSessionKeyPatch = {}): RuntimeSessionSecrets {
    const current = this.#sessions.get(sessionId);
    const next = new RuntimeSessionSecrets({
      deepseekApiKey: Object.hasOwn(patch, "deepseekApiKey")
        ? (patch.deepseekApiKey ?? undefined)
        : current?.deepseekApiKey,
      tavilyApiKey: Object.hasOwn(patch, "tavilyApiKey")
        ? (patch.tavilyApiKey ?? undefined)
        : current?.tavilyApiKey,
    });
    if (this.#sessions.has(sessionId)) {
      this.#sessions.set(sessionId, next);
      return next;
    }
    if (this.#sessions.size >= MAX_RUNTIME_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest) {
        this.#sessions.delete(oldest);
      }
    }
    this.#sessions.set(sessionId, next);
    return next;
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.#sessions.delete(sessionId);
      return;
    }
    this.#sessions.clear();
  }

  toJSON(): { size: number } {
    return { size: this.#sessions.size };
  }

  [inspect.custom](): string {
    return `RuntimeSessionStore { size: ${this.#sessions.size} }`;
  }
}

const store = new RuntimeSessionStore();

export function getRuntimeSessionStore(): RuntimeSessionStore {
  return store;
}

export function resetRuntimeSessionStore(): void {
  store.clear();
}
