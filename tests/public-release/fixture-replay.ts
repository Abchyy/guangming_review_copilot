import http from "node:http";

import type { FixtureScenario, FixtureStep } from "./fixture-catalog";

const LIVE_ENV_KEYS = [
  "PUBLIC_API_BASE_URL",
  "PUBLIC_RELEASE_LIVE_BLACKBOX",
  "WECHAT_APPID",
  "WECHAT_APPSECRET",
  "WX_APPID",
];

export function assertFixtureLaneStaysOffline(): void {
  for (const key of LIVE_ENV_KEYS) {
    if (process.env[key]) {
      throw new Error(
        `Public release fixture tests refuse ${key}. Live WeChat, model, or production calls are out of this lane.`,
      );
    }
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return normalized;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) {
    return null;
  }
  if ((contentType ?? "").includes("application/json")) {
    return JSON.parse(raw) as unknown;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function requestMatches(incoming: FixtureStep["request"], recorded: FixtureStep["request"]): boolean {
  if (incoming.method.toUpperCase() !== recorded.method.toUpperCase()) {
    return false;
  }
  if (incoming.path !== recorded.path) {
    return false;
  }
  const incomingHeaders = normalizeHeaders(incoming.headers);
  const recordedHeaders = normalizeHeaders(recorded.headers);
  for (const [key, value] of Object.entries(recordedHeaders)) {
    if (incomingHeaders[key] !== value) {
      return false;
    }
  }
  return jsonEqual(incoming.body ?? null, recorded.body ?? null);
}

export type ReplayResult = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
};

async function listen(server: http.Server): Promise<{ port: number }> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture replay server did not bind to a TCP port");
  }
  return { port: address.port };
}

export async function replayStep(step: FixtureStep): Promise<ReplayResult> {
  assertFixtureLaneStaysOffline();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const incomingHeaders = normalizeHeaders(req.headers as Record<string, string | string[] | undefined>);
      const incoming: FixtureStep["request"] = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: incomingHeaders,
        body: parseBody(raw, incomingHeaders["content-type"]),
      };
      if (!requestMatches(incoming, step.request)) {
        res.statusCode = 598;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              code: "FIXTURE_REQUEST_MISMATCH",
              message: "Incoming request did not match the recorded fixture request.",
            },
          }),
        );
        return;
      }
      res.statusCode = step.response.status;
      for (const [key, value] of Object.entries(step.response.headers)) {
        res.setHeader(key, value);
      }
      if (step.response.body === null || step.response.body === undefined) {
        res.end();
        return;
      }
      res.end(JSON.stringify(step.response.body));
    });
  });

  try {
    const { port } = await listen(server);
    const headers = new Headers();
    for (const [key, value] of Object.entries(step.request.headers)) {
      headers.set(key, value);
    }
    const init: RequestInit = {
      method: step.request.method,
      headers,
    };
    if (step.request.body !== null && step.request.body !== undefined) {
      init.body = JSON.stringify(step.request.body);
    }
    const response = await fetch(`http://127.0.0.1:${port}${step.request.path}`, init);
    const raw = await response.text();
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      raw,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

export async function replayScenario(scenario: FixtureScenario): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const step of scenario.steps) {
    results.push(await replayStep(step));
  }
  return results;
}
