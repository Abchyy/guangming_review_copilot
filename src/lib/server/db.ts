import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  original_title TEXT NOT NULL,
  original_body TEXT NOT NULL,
  current_title TEXT NOT NULL,
  current_body TEXT NOT NULL,
  article_version INTEGER NOT NULL,
  findings_json TEXT NOT NULL,
  pipeline_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_actions (
  action_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_article_version INTEGER NOT NULL,
  to_article_version INTEGER NOT NULL,
  replaced_text TEXT,
  replacement TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (review_id) REFERENCES reviews(review_id)
);
`;

const singletons = new Map<string, Database.Database>();

export function getReviewDbPath(): string {
  const configured = process.env.REVIEW_DB_PATH?.trim();
  return configured && configured.length > 0
    ? configured
    : join(process.cwd(), ".data", "guangming-review.db");
}

export function openReviewDatabase(filePath: string): Database.Database {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function getReviewDatabase(filePath = getReviewDbPath()): Database.Database {
  const existing = singletons.get(filePath);
  if (existing) {
    return existing;
  }
  const db = openReviewDatabase(filePath);
  singletons.set(filePath, db);
  return db;
}

export function closeReviewDatabases(): void {
  for (const db of singletons.values()) {
    db.close();
  }
  singletons.clear();
}
