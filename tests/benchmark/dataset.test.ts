import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadBenchmarkDataset, selectDevArticles, selectRegressionArticles } from "@grc/benchmark";

describe("benchmark dataset freeze", () => {
  test("dataset file remains 6 dev / 12 regression and has no official locked split", () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "data/benchmark/dataset.json"), "utf8"),
    ) as { articles: Array<{ split: string }> };
    expect(raw.articles.filter((item) => item.split === "dev")).toHaveLength(6);
    expect(raw.articles.filter((item) => item.split === "regression")).toHaveLength(12);
    expect(raw.articles.filter((item) => item.split === "locked")).toHaveLength(0);
  });

  test("selects exactly 6 development articles and never iterates former locked as official", () => {
    const dataset = loadBenchmarkDataset();
    const dev = selectDevArticles(dataset);
    const regression = selectRegressionArticles(dataset);
    expect(dev).toHaveLength(6);
    expect(regression).toHaveLength(12);
    expect(dev.every((item) => item.split === "dev")).toBe(true);
    expect(dev.some((item) => item.split === "regression")).toBe(false);
    expect(regression.every((item) => item.split === "regression")).toBe(true);
  });
});
