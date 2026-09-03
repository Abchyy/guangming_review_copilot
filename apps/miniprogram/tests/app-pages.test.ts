import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("miniprogram page manifest", () => {
  it("declares only pages that exist on disk", () => {
    const appJson = JSON.parse(readFileSync(join(root, "app.json"), "utf8")) as {
      pages: string[];
      window: { navigationBarTitleText: string };
    };
    assert.equal(appJson.window.navigationBarTitleText, "AI 审校助手");
    assert.ok(appJson.pages.length > 0);
    assert.ok(existsSync(join(root, "app.ts")), "missing app.ts");
    assert.equal(existsSync(join(root, "app.js")), false, "handwritten app.js must not exist");
    for (const page of appJson.pages) {
      assert.ok(existsSync(join(root, `${page}.wxml`)), `missing ${page}.wxml`);
      assert.ok(existsSync(join(root, `${page}.json`)), `missing ${page}.json`);
      assert.ok(existsSync(join(root, `${page}.ts`)), `missing ${page}.ts`);
      assert.equal(
        existsSync(join(root, `${page}.js`)),
        false,
        `handwritten ${page}.js must not exist; WeChat DevTools compiles the .ts source`,
      );
    }
  });

  it("enables WeChat DevTools TypeScript compilation", () => {
    const project = JSON.parse(readFileSync(join(root, "project.config.json"), "utf8")) as {
      setting?: { enhance?: boolean; useCompilerPlugins?: unknown };
    };
    assert.equal(project.setting?.enhance, true);
    assert.deepEqual(project.setting?.useCompilerPlugins, ["typescript"]);
  });

  it("does not embed a real AppID or production domain", () => {
    const project = readFileSync(join(root, "project.config.json"), "utf8");
    const config = readFileSync(join(root, "config.ts"), "utf8");
    assert.equal(JSON.parse(project).appid, undefined);
    assert.match(config, /CLIENT_MODE: ClientMode = "fixture"/);
    assert.doesNotMatch(config, /https:\/\//);
  });

  it("does not send a retired fixture privacy notice version", () => {
    const retired = ["public", "v1", "fixture"].join("-");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") {
          continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|js|json|wxml|wxss|mjs|md)$/.test(entry)) {
          continue;
        }
        const text = readFileSync(full, "utf8");
        if (text.includes(retired)) {
          hits.push(full.replace(`${root}/`, ""));
        }
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
});
