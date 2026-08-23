import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));

const PACKAGES = [
  "@grc/contracts",
  "@grc/review-core",
  "@grc/rules-engine",
  "@grc/retrieval",
  "@grc/providers",
  "@grc/review-store",
  "@grc/benchmark",
  "@grc/holdout-protocol",
  "@grc/test-kit",
] as const;

describe("workspace package exports", () => {
  test("root package.json declares npm workspaces", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    expect(pkg.workspaces).toEqual(["apps/*", "packages/*"]);
  });

  test("each library package resolves through its public export", () => {
    for (const name of PACKAGES) {
      const resolved = require.resolve(name);
      expect(resolved.replaceAll("\\", "/")).toContain(`/${name.slice(5)}/src/index.ts`);
    }
  });

  test("web app is a workspace package", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "apps/web/package.json"), "utf8"),
    ) as { name: string };
    expect(pkg.name).toBe("@grc/web");
  });
});
