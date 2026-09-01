import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[A-Za-z0-9]+$/.test(specifier)
  ) {
    const candidate = `${specifier}.ts`;
    if (context.parentURL) {
      const resolved = new URL(candidate, context.parentURL);
      if (existsSync(fileURLToPath(resolved))) {
        return nextResolve(candidate, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
