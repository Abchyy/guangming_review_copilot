import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadBenchmarkDataset } from "@/lib/server/benchmark/dataset";

describe("benchmark dataset freeze", () => {
  test("dataset file remains 6 dev / 12 locked", () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "data/benchmark/dataset.json"), "utf8"),
    ) as { articles: Array<{ split: string }> };
    expect(raw.articles.filter((item) => item.split === "dev")).toHaveLength(6);
    expect(raw.articles.filter((item) => item.split === "locked")).toHaveLength(12);
  });

  test("selects exactly 6 development articles and never iterates locked", () => {
    const dataset = loadBenchmarkDataset();
    const dev = dataset.articles.filter((item) => item.split === "dev");
    const locked = dataset.articles.filter((item) => item.split === "locked");
    expect(dev).toHaveLength(6);
    expect(locked).toHaveLength(12);
    expect(dev.every((item) => item.split === "dev")).toBe(true);
    expect(dev.some((item) => item.split === "locked")).toBe(false);
  });
});
