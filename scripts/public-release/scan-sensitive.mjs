#!/usr/bin/env node
/**
 * Repeatable sensitive-data scan for the public-release gate.
 *
 * This is a STATIC_CHECK. A passing scan does not prove production logging,
 * TTL, or deletion are deployed.
 *
 * Usage:
 *   node scripts/public-release/scan-sensitive.mjs
 *   node scripts/public-release/scan-sensitive.mjs --json
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".next",
  "node_modules",
  "coverage",
  "dist",
  "out",
  "build",
]);

const SKIP_FILE_NAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".env",
  ".example",
  ".css",
  ".html",
  ".svg",
]);

const SECRET_PATTERNS = [
  { id: "pem_private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { id: "github_pat", re: /ghp_[A-Za-z0-9]{36}/g },
  { id: "slack_bot_token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    id: "provider_key",
    re: /\b(?:sk-|tvly-)[A-Za-z0-9]{8,}\b/g,
  },
  {
    id: "wechat_app_secret_assignment",
    re: /(?:WECHAT_APPSECRET|WX_APPSECRET|AppSecret)\s*[:=]\s*['\"][A-Za-z0-9]{16,}['\"]/g,
  },
];

const LOG_FORBIDDEN_PATTERNS = [
  { id: "bearer_token", re: /bearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { id: "authorization_header", re: /authorization["']?\s*[:=]\s*["']?bearer/gi },
  { id: "session_token", re: /session_token/gi },
  { id: "openid", re: /openid/gi },
  { id: "unionid", re: /unionid/gi },
];

const ERROR_FORBIDDEN_PATTERNS = [
  { id: "stack_field", re: /"stack"\s*:/g },
  { id: "stack_frame", re: /\bat\s+\S+\s+\([^)]+:\d+:\d+\)/g },
  { id: "sql_field", re: /"sql"\s*:/g },
  { id: "provider_key", re: /\b(?:sk-|tvly-)[A-Za-z0-9]{8,}\b/g },
  { id: "app_secret", re: /appsecret/gi },
];

const CANARY_HINT = /canary|fixture|isolation|should-be-rejected|sk-session|leak-deepseek|leak-tavily|example|placeholder|test-only/i;

function walk(dir, files = []) {
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walk(absolute, files);
      continue;
    }
    if (SKIP_FILE_NAMES.has(entry.name)) {
      continue;
    }
    files.push(absolute);
  }
  return files;
}

function isProbablyText(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  const base = filePath.split("/").pop() ?? "";
  return base.startsWith(".env") || base.endsWith(".jsonl");
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function isTestPath(filePath) {
  return /(^|\/)tests\//.test(filePath.replaceAll("\\", "/"));
}

function allowProviderKey(filePath, match) {
  const relativePath = filePath.replaceAll("\\", "/");
  if (isTestPath(relativePath)) {
    return true;
  }
  if (CANARY_HINT.test(match)) {
    return true;
  }
  if (relativePath.endsWith("/privacy.ts") && match.startsWith("sk-")) {
    return true;
  }
  if ((relativePath.includes("/docs/") || relativePath.endsWith(".md")) && match.length <= 12) {
    return true;
  }
  return false;
}

export function scanTextForSecrets(filePath, content) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of content.matchAll(pattern.re)) {
      const value = match[0];
      if (pattern.id === "provider_key" && allowProviderKey(filePath, value)) {
        continue;
      }
      findings.push({
        file: filePath,
        line: lineOf(content, match.index ?? 0),
        rule: pattern.id,
        excerpt: value.slice(0, 48),
      });
    }
  }
  return findings;
}

export function scanLogSample(content, articleBodies = []) {
  const findings = [];
  for (const pattern of LOG_FORBIDDEN_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of content.matchAll(pattern.re)) {
      findings.push({
        rule: pattern.id,
        excerpt: match[0].slice(0, 48),
      });
    }
  }
  for (const body of articleBodies) {
    if (body && content.includes(body)) {
      findings.push({
        rule: "full_article_body",
        excerpt: body.slice(0, 48),
      });
    }
  }
  return findings;
}

export function scanErrorPayload(content) {
  const findings = [];
  for (const pattern of ERROR_FORBIDDEN_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of content.matchAll(pattern.re)) {
      findings.push({
        rule: pattern.id,
        excerpt: match[0].slice(0, 48),
      });
    }
  }
  return findings;
}

function collectArticleBodies(root) {
  const articleFile = join(root, "tests/fixtures/public-api/articles/synthetic-short.json");
  if (!existsSync(articleFile)) {
    return [];
  }
  const article = JSON.parse(readFileSync(articleFile, "utf8"));
  return [article.body, article.title].filter((item) => typeof item === "string" && item.length > 0);
}

function listRepositoryFiles(root) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard"],
      { cwd: root, encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relativePath) => join(root, relativePath));
  } catch {
    return walk(root);
  }
}

export function scanPublicReleaseGate(root = process.cwd()) {
  const findings = [];
  const repoFiles = listRepositoryFiles(root).filter((file) => {
    try {
      return statSync(file).isFile() && statSync(file).size <= 1_000_000 && isProbablyText(file);
    } catch {
      return false;
    }
  });

  for (const file of repoFiles) {
    const content = readFileSync(file, "utf8");
    const relativePath = relative(root, file);
    for (const finding of scanTextForSecrets(relativePath, content)) {
      findings.push({ scope: "repo_secrets", ...finding });
    }
  }

  const articleBodies = collectArticleBodies(root);
  const logDir = join(root, "tests/fixtures/public-api/logs");
  for (const file of walk(logDir)) {
    const content = readFileSync(file, "utf8");
    const relativePath = relative(root, file);
    for (const finding of scanLogSample(content, articleBodies)) {
      findings.push({ scope: "log_samples", file: relativePath, ...finding });
    }
  }

  const scenarioDir = join(root, "tests/fixtures/public-api/scenarios");
  const errorExamples = join(root, "tests/fixtures/public-api/contract/error-examples.json");
  const errorFiles = [...walk(scenarioDir), ...(existsSync(errorExamples) ? [errorExamples] : [])];
  for (const file of errorFiles) {
    const content = readFileSync(file, "utf8");
    const relativePath = relative(root, file);
    const parsed = JSON.parse(content);
    const errorBodies = [];
    const collect = (value) => {
      if (!value || typeof value !== "object") {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if ("error" in value && value.error) {
        errorBodies.push(value);
      }
      if (value.response?.body?.error) {
        errorBodies.push(value.response.body);
      }
      Object.values(value).forEach(collect);
    };
    collect(parsed);
    for (const body of errorBodies) {
      for (const finding of scanErrorPayload(JSON.stringify(body))) {
        findings.push({ scope: "error_payloads", file: relativePath, ...finding });
      }
    }
  }

  return findings;
}

function main() {
  const json = process.argv.includes("--json");
  const findings = scanPublicReleaseGate(process.cwd());
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write("PUBLIC_RELEASE_SCAN: PASS\n");
    process.stdout.write(
      "STATIC_CHECK only. This does not prove production logging, TTL, or delete jobs are deployed.\n",
    );
  } else {
    process.stdout.write("PUBLIC_RELEASE_SCAN: FAIL\n");
    for (const finding of findings) {
      process.stdout.write(
        `- [${finding.scope}] ${finding.file ?? ""}:${finding.line ?? "-"} ${finding.rule} ${finding.excerpt}\n`,
      );
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("scan-sensitive.mjs");
if (invokedDirectly) {
  main();
}
