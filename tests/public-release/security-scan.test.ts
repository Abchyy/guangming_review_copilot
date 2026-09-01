import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  scanErrorPayload,
  scanLogSample,
  scanPublicReleaseGate,
} from "../../scripts/public-release/scan-sensitive.mjs";
import { loadSyntheticArticle, PUBLIC_API_FIXTURE_ROOT } from "./fixture-catalog";

describe("sensitive information scan", () => {
  test("CLI scanner exits 0 on the current worktree", () => {
    const output = execFileSync(process.execPath, ["scripts/public-release/scan-sensitive.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("PUBLIC_RELEASE_SCAN: PASS");
    expect(output).toContain("STATIC_CHECK only");
  });

  test("imported scanner reports no findings", () => {
    expect(scanPublicReleaseGate(process.cwd())).toEqual([]);
  });

  test("log samples omit bearer tokens and the full manuscript", () => {
    const article = loadSyntheticArticle();
    const sample = readFileSync(join(PUBLIC_API_FIXTURE_ROOT, "logs/safe-sample.jsonl"), "utf8");
    expect(scanLogSample(sample, [article.title, article.body])).toEqual([]);
  });

  test("detects unsafe log content in memory without writing it to the repo", () => {
    const article = loadSyntheticArticle();
    const findings = scanLogSample(
      `authorization: Bearer sess_fixture_owner_a\nopenid=o-fixture\n${article.body}`,
      [article.body],
    );
    expect(findings.map((item) => item.rule).sort()).toEqual([
      "authorization_header",
      "bearer_token",
      "full_article_body",
      "openid",
    ]);
  });

  test("detects stack traces and provider keys in error payloads", () => {
    const findings = scanErrorPayload(
      JSON.stringify({
        request_id: "req_x",
        error: { code: "UPSTREAM_UNAVAILABLE", message: "boom" },
        stack: "Error: boom\n    at Worker.run (worker.ts:12:3)",
        api_key: "sk-CANARYNOTAREALKEY123456",
      }),
    );
    expect(findings.map((item) => item.rule)).toEqual(
      expect.arrayContaining(["stack_field", "stack_frame", "provider_key"]),
    );
  });

  test("recorded error fixtures stay leak-free", () => {
    const examples = JSON.parse(
      readFileSync(join(PUBLIC_API_FIXTURE_ROOT, "contract/error-examples.json"), "utf8"),
    ) as { examples: Array<{ body: unknown }> };
    for (const example of examples.examples) {
      expect(scanErrorPayload(JSON.stringify(example.body))).toEqual([]);
    }
  });
});
