import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HoldoutProtocolError } from "@/lib/server/benchmark/holdout/errors";

export type SealedArtifactKind = "freeze" | "system-freeze" | "run-freeze" | "prediction" | "result";

export function sealedArtifactPath(directory: string, kind: SealedArtifactKind, id: string): string {
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
