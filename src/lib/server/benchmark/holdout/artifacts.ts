import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";

export function sealedArtifactPath(directory: string, kind: "freeze" | "prediction" | "result", id: string): string {
  return join(directory, `${kind}-${id}.json`);
}

export function writeSealedJson(filePath: string, value: unknown): void {
  if (existsSync(filePath)) {
    throw new HoldoutProtocolError(`Refusing to overwrite sealed artifact: ${filePath}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
