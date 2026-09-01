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
    for (const page of appJson.pages) {
      assert.ok(existsSync(join(root, `${page}.wxml`)), `missing ${page}.wxml`);
      assert.ok(existsSync(join(root, `${page}.json`)), `missing ${page}.json`);
      assert.ok(
        existsSync(join(root, `${page}.ts`)) || existsSync(join(root, `${page}.js`)),
        `missing ${page} script`,
      );
    }
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
