import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { EVIDENCE_CLASSES } from "./api-v0-contract";
import gateMatrix from "./gate-matrix.json";

const REQUIRED_NOT_VERIFIED_OFFICIAL = [
  "OFF-ENTITY",
  "OFF-ICP-FILING",
  "OFF-APPID",
  "OFF-HTTPS-DOMAIN",
  "OFF-PRIVACY-GUIDE",
  "OFF-GENERATIVE-AI",
  "OFF-WECHAT-REVIEW",
  "OFF-STRANGER-QR",
] as const;

type GateItem = {
  id: string;
  item: string;
  criteria: string;
  verification: string;
  expected_evidence: string;
  status: string;
  blockers: string[];
};

function allItems(): GateItem[] {
  return gateMatrix.lanes.flatMap((lane) => lane.items as GateItem[]);
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      walk(absolute, files);
    } else {
      files.push(absolute);
    }
  }
  return files;
}

describe("public release gate matrix", () => {
  test("every item has criteria, verification, evidence, status and blockers", () => {
    expect(gateMatrix.phase).toBe("fixture_development");
    expect(gateMatrix.product_working_name).toBe("AI 审校助手");
    expect(gateMatrix.baseline_sha).toBe("7af7a05fb05dd26aa6347fc1d1c9094e45836077");
    for (const item of allItems()) {
      expect(item.id, item.item).toMatch(/^[A-Z]+-[A-Z0-9-]+$/);
      expect(item.criteria.length, `${item.id} criteria`).toBeGreaterThan(8);
      expect(item.verification.length, `${item.id} verification`).toBeGreaterThan(8);
      expect(item.expected_evidence.length, `${item.id} evidence`).toBeGreaterThan(8);
      expect(EVIDENCE_CLASSES).toContain(item.status);
      expect(Array.isArray(item.blockers)).toBe(true);
    }
  });

  test("required official items stay NOT VERIFIED", () => {
    const items = new Map(allItems().map((item) => [item.id, item]));
    for (const id of REQUIRED_NOT_VERIFIED_OFFICIAL) {
      expect(items.get(id)?.status, id).toBe("NOT_VERIFIED");
      expect(items.get(id)?.blockers.length, id).toBeGreaterThan(0);
    }
  });

  test("does not treat fixture or preview evidence as a public WeChat pass", () => {
    for (const item of allItems()) {
      expect(item.status).not.toBe("PASS");
      expect(item.expected_evidence).not.toMatch(/任何人扫码即可使用/);
    }
    const official = gateMatrix.lanes.find((lane) => lane.id === "official_release");
    for (const item of official?.items ?? []) {
      expect(["NOT_VERIFIED", "BLOCKED_EXTERNAL"]).toContain(item.status);
    }
    const preview = gateMatrix.lanes.find((lane) => lane.id === "wechat_preview");
    for (const item of preview?.items ?? []) {
      if (item.id === "WX-DEV-NOT-PUBLIC") {
        expect(item.status).toBe("STATIC_CHECK");
        continue;
      }
      expect(["NOT_VERIFIED", "BLOCKED_EXTERNAL", "STATIC_CHECK"]).toContain(item.status);
      expect(item.status).not.toBe("FIXTURE_VERIFIED");
    }
  });

  test("gate document lists every matrix item and the preview-QR disclaimer", () => {
    const markdown = readFileSync(join(process.cwd(), "docs/wechat-public-release-gate.md"), "utf8");
    expect(markdown).toContain("开发版或体验版二维码不能证明“任何人扫码即可使用”");
    expect(markdown).toContain("NOT VERIFIED");
    expect(markdown).toContain("AI 审校助手");
    expect(markdown).not.toContain("不存在 `/api/v1`");
    expect(markdown).not.toContain("不存在 `apps/miniprogram`");
    expect(markdown).not.toContain("产品 Public API 尚未实现");
    for (const item of allItems()) {
      expect(markdown, item.id).toContain(item.id);
    }
  });

  test("public-release tests do not import product app code", () => {
    const root = join(process.cwd(), "tests/public-release");
    for (const file of walk(root).filter((path) => path.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from ["']@\//);
      expect(source, file).not.toMatch(/apps\/web/);
      expect(source, file).not.toMatch(/from ["']@grc\//);
    }
  });
});
