import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(rootDir, "apps/web/src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: [
      ...configDefaults.exclude,
      "tests/live/**",
      "tests/benchmark/holdout-chdir-probe.test.ts",
      "tests/benchmark/holdout-consume-race-probe.test.ts",
      "tests/benchmark/holdout-pre-inference-probe.test.ts",
    ],
    setupFiles: ["./tests/setup.ts"],
  },
});
