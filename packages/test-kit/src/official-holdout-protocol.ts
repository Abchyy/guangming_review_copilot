import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOfficialSystemFreeze } from "@grc/holdout-protocol";
import { loadInputPack, type InputPack } from "@grc/holdout-protocol";
import {
  HOLDOUT_CUSTODIAN_HOME_ENV,
  canonicalOfficialLifecyclePath,
  syntheticLockedRegistry,
  writeCustodianLifecycle,
} from "@grc/holdout-protocol";
import { createOfficialRunFreeze, type RunFreezeManifest } from "@grc/holdout-protocol";
import type { SystemFreezeManifest } from "@grc/holdout-protocol";
import { DEFAULT_DEEPSEEK_BASE_URL } from "@grc/providers";

export const PROTOCOL_TEST_PROVIDER_KEY = "sk-test-holdout-protocol-not-a-real-secret";

export function applyProtocolProviderEnv(): void {
  process.env.DEEPSEEK_API_KEY = PROTOCOL_TEST_PROVIDER_KEY;
  process.env.DEEPSEEK_BASE_URL = DEFAULT_DEEPSEEK_BASE_URL;
}

export function restoreEnvValue(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

export function withProtocolProviderEnv<T>(run: () => T): T {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousUrl = process.env.DEEPSEEK_BASE_URL;
  applyProtocolProviderEnv();
  try {
    return run();
  } finally {
    restoreEnvValue("DEEPSEEK_API_KEY", previousKey);
    restoreEnvValue("DEEPSEEK_BASE_URL", previousUrl);
  }
}

export async function withProtocolProviderEnvAsync<T>(run: () => Promise<T>): Promise<T> {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousUrl = process.env.DEEPSEEK_BASE_URL;
  applyProtocolProviderEnv();
  try {
    return await run();
  } finally {
    restoreEnvValue("DEEPSEEK_API_KEY", previousKey);
    restoreEnvValue("DEEPSEEK_BASE_URL", previousUrl);
  }
}

export function withCustodianHome<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "holdout-custodian-"));
  const previous = process.env[HOLDOUT_CUSTODIAN_HOME_ENV];
  process.env[HOLDOUT_CUSTODIAN_HOME_ENV] = home;
  try {
    return run(home);
  } finally {
    restoreEnvValue(HOLDOUT_CUSTODIAN_HOME_ENV, previous);
  }
}

export async function withCustodianHomeAsync<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "holdout-custodian-"));
  const previous = process.env[HOLDOUT_CUSTODIAN_HOME_ENV];
  process.env[HOLDOUT_CUSTODIAN_HOME_ENV] = home;
  try {
    return await run(home);
  } finally {
    restoreEnvValue(HOLDOUT_CUSTODIAN_HOME_ENV, previous);
  }
}

export function writeExternalLockedInput(articleId = "ext-01"): InputPack {
  const dir = mkdtempSync(join(tmpdir(), "holdout-external-locked-"));
  const filePath = join(dir, "input.json");
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        schema_version: "holdout-input.v1",
        pack_id: "external-locked-input-v1",
        role: "locked",
        articles: [
          {
            article_id: articleId,
            title: "外部输入稿",
            body: "这是一份不含标注的 repo 外 locked input。",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return loadInputPack(filePath);
}

export function writeSyntheticLockedHoldout(input: {
  holdoutId: string;
  articleIds: string[];
}): string {
  const lifecyclePath = canonicalOfficialLifecyclePath(input.holdoutId);
  writeCustodianLifecycle(lifecyclePath, syntheticLockedRegistry(input));
  return lifecyclePath;
}

export function setupOfficialTwoStage(options: {
  artifactDir?: string;
  holdoutId?: string;
  articleId?: string;
} = {}): {
  artifactDir: string;
  holdoutId: string;
  inputPack: InputPack;
  systemFreeze: SystemFreezeManifest;
  runFreeze: RunFreezeManifest;
} {
  const artifactDir = options.artifactDir ?? mkdtempSync(join(tmpdir(), "holdout-two-stage-"));
  const holdoutId = options.holdoutId ?? "synthetic-locked-repair5";
  const inputPack = writeExternalLockedInput(options.articleId);
  writeSyntheticLockedHoldout({
    holdoutId,
    articleIds: inputPack.articles.map((item) => item.article_id),
  });
  const systemFreeze = createOfficialSystemFreeze({ artifactDir });
  const runFreeze = createOfficialRunFreeze({
    artifactDir,
    systemFreeze,
    inputPack,
    holdoutId,
  });
  return { artifactDir, holdoutId, inputPack, systemFreeze, runFreeze };
}
