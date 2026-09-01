import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  PUBLIC_API_ERROR_CODES,
  PUBLIC_API_ERROR_HTTP_STATUS,
  PUBLIC_BODY_MAX_LENGTH,
  PUBLIC_DEFAULT_DAILY_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS,
  PUBLIC_DEFAULT_RUNNING_LIMIT,
  PUBLIC_PRIVACY_NOTICE_VERSION,
  PUBLIC_REVIEW_DEGRADATION_NOTICE,
  PUBLIC_REVIEW_STATUSES,
  PUBLIC_TITLE_MAX_LENGTH,
} from "@grc/contracts";

import {
  PRODUCT_NAME,
  PUBLIC_API_ERROR_HTTP_STATUS as MINIPROGRAM_ERROR_HTTP,
} from "../../apps/miniprogram/services/contract";
import {
  PUBLIC_API_ERROR_CODES as MINIPROGRAM_ERROR_CODES,
  PUBLIC_BODY_MAX_LENGTH as MINIPROGRAM_BODY_MAX,
  PUBLIC_DEFAULT_DAILY_LIMIT as MINIPROGRAM_DAILY_LIMIT,
  PUBLIC_DEFAULT_POLL_AFTER_MS as MINIPROGRAM_POLL_AFTER_MS,
  PUBLIC_DEFAULT_RUNNING_LIMIT as MINIPROGRAM_RUNNING_LIMIT,
  PUBLIC_PRIVACY_NOTICE_VERSION as MINIPROGRAM_PRIVACY_VERSION,
  PUBLIC_REVIEW_DEGRADATION_NOTICE as MINIPROGRAM_DEGRADATION_NOTICE,
  PUBLIC_REVIEW_STATUSES as MINIPROGRAM_STATUSES,
  PUBLIC_TITLE_MAX_LENGTH as MINIPROGRAM_TITLE_MAX,
} from "../../apps/miniprogram/services/types";
import fixtureContract from "../fixtures/public-api/contract/api-v0.json";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("public API v0 cross-source alignment", () => {
  test("miniprogram projection matches backend contract constants", () => {
    expect(MINIPROGRAM_TITLE_MAX).toBe(PUBLIC_TITLE_MAX_LENGTH);
    expect(MINIPROGRAM_BODY_MAX).toBe(PUBLIC_BODY_MAX_LENGTH);
    expect(MINIPROGRAM_DAILY_LIMIT).toBe(PUBLIC_DEFAULT_DAILY_LIMIT);
    expect(MINIPROGRAM_RUNNING_LIMIT).toBe(PUBLIC_DEFAULT_RUNNING_LIMIT);
    expect(MINIPROGRAM_POLL_AFTER_MS).toBe(PUBLIC_DEFAULT_POLL_AFTER_MS);
    expect(MINIPROGRAM_PRIVACY_VERSION).toBe(PUBLIC_PRIVACY_NOTICE_VERSION);
    expect(MINIPROGRAM_DEGRADATION_NOTICE).toBe(PUBLIC_REVIEW_DEGRADATION_NOTICE);
    expect([...MINIPROGRAM_STATUSES]).toEqual([...PUBLIC_REVIEW_STATUSES]);
    expect([...MINIPROGRAM_ERROR_CODES]).toEqual([...PUBLIC_API_ERROR_CODES]);
    expect(MINIPROGRAM_ERROR_HTTP).toEqual(PUBLIC_API_ERROR_HTTP_STATUS);
  });

  test("release fixtures match backend contract constants", () => {
    expect(fixtureContract.product_working_name).toBe("AI 审校助手");
    expect(fixtureContract.privacy_notice_version).toBe(PUBLIC_PRIVACY_NOTICE_VERSION);
    expect(fixtureContract.limits.title_max_utf16).toBe(PUBLIC_TITLE_MAX_LENGTH);
    expect(fixtureContract.limits.body_max_utf16).toBe(PUBLIC_BODY_MAX_LENGTH);
    expect(fixtureContract.limits.daily_limit_default).toBe(PUBLIC_DEFAULT_DAILY_LIMIT);
    expect(fixtureContract.limits.running_limit_default).toBe(PUBLIC_DEFAULT_RUNNING_LIMIT);
    expect(fixtureContract.limits.poll_after_ms_default).toBe(PUBLIC_DEFAULT_POLL_AFTER_MS);
    expect(fixtureContract.degraded_caution).toBe(PUBLIC_REVIEW_DEGRADATION_NOTICE);
    expect(fixtureContract.review_statuses).toEqual([...PUBLIC_REVIEW_STATUSES]);
    expect(fixtureContract.error_codes.map((item) => item.code)).toEqual([
      ...PUBLIC_API_ERROR_CODES,
    ]);
    for (const item of fixtureContract.error_codes) {
      expect(PUBLIC_API_ERROR_HTTP_STATUS[item.code as keyof typeof PUBLIC_API_ERROR_HTTP_STATUS]).toBe(
        item.http,
      );
    }
  });

  test("public working name stays AI 审校助手 on the miniprogram and release fixtures", () => {
    expect(PRODUCT_NAME).toBe("AI 审校助手");
    expect(PRODUCT_NAME).toBe(fixtureContract.product_working_name);
    const appJson = JSON.parse(
      readFileSync(join(root, "apps/miniprogram/app.json"), "utf8"),
    ) as { window: { navigationBarTitleText: string } };
    expect(appJson.window.navigationBarTitleText).toBe("AI 审校助手");
  });

  test("miniprogram stays a local projection and does not import backend packages", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "apps/miniprogram"))) {
      if (!/\.(ts|mjs|json)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (/from\s+["']@grc\//.test(text) || /from\s+["']@\//.test(text) || text.includes("apps/web")) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
