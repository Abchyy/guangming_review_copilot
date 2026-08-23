import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const matches = [
    ...text.matchAll(/from\s+["']([^"']+)["']/g),
    ...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return matches.map((item) => item[1]!);
}

const FORBIDDEN: Record<string, string[]> = {
  contracts: ["@grc/review-core", "@grc/rules-engine", "@grc/retrieval", "@grc/providers", "@grc/review-store", "@grc/benchmark", "@grc/holdout-protocol", "next", "react", "better-sqlite3"],
  "review-core": ["next", "react", "better-sqlite3", "@grc/benchmark", "@grc/holdout-protocol", "@grc/review-store"],
  "rules-engine": ["@grc/review-core", "@grc/holdout-protocol", "@grc/benchmark", "next", "react"],
  retrieval: ["@grc/review-core", "@grc/holdout-protocol", "@grc/benchmark", "next", "react"],
  providers: ["@grc/rules-engine", "@grc/review-core", "@grc/review-store", "@grc/benchmark", "@grc/holdout-protocol"],
  "review-store": ["@grc/review-core", "@grc/benchmark", "@grc/holdout-protocol", "next", "react"],
  web: ["@grc/benchmark", "@grc/holdout-protocol", "@grc/test-kit"],
};

describe("module boundaries", () => {
  test("packages do not deep-import another package src tree", () => {
    const files = [
      ...walk(join(root, "packages")),
      ...walk(join(root, "apps/web/src")),
      ...walk(join(root, "tests")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (/@grc\/[^"']+\/src(\/|$)/.test(spec) || spec.includes("/src/internal")) {
          offenders.push(`${relative(root, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("declared dependency bans are respected in source", () => {
    const offenders: string[] = [];
    for (const [folder, banned] of Object.entries(FORBIDDEN)) {
      const dir = folder === "web" ? join(root, "apps/web/src") : join(root, "packages", folder, "src");
      for (const file of walk(dir)) {
        for (const spec of importsOf(file)) {
          if (banned.some((item) => spec === item || spec.startsWith(`${item}/`))) {
            offenders.push(`${relative(root, file)} -> ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("tests consume shared helpers through the test-kit package", () => {
    const offenders = walk(join(root, "tests")).filter((file) =>
      importsOf(file).some((spec) => spec.includes("helpers/")),
    );
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });
});
