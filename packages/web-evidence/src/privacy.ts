import type { CanonicalArticle } from "@grc/contracts";
import { WEB_EVIDENCE_MAX_QUERY_CHARS } from "@grc/contracts";

const SECRET_RE =
  /api[_-]?key\s*[:=]|sk-[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9\-._~+/]+=*/i;
const HOLDOUT_RE = /holdout/i;
const INTERNAL_NOTE_RE = /内部批注|内部备注|【批注】|【内部】/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;

export function normalizeFactClaim(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function minimizeFactClaim(
  raw: string,
  article?: Pick<CanonicalArticle, "title" | "body">,
): string | null {
  const normalized = normalizeFactClaim(raw);
  if (normalized.length < 2) {
    return null;
  }
  if (SECRET_RE.test(normalized) || HOLDOUT_RE.test(normalized) || INTERNAL_NOTE_RE.test(normalized)) {
    return null;
  }
  if (article && leaksArticleBody(normalized, article)) {
    return null;
  }
  const newlineCount = (raw.match(/\n/g) ?? []).length;
  if (normalized.length > 200 || newlineCount >= 2) {
    return null;
  }
  const stripped = normalizeFactClaim(
    normalized.replace(EMAIL_RE, " ").replace(PHONE_RE, " "),
  );
  if (stripped.length < 2) {
    return null;
  }
  if (stripped.length > WEB_EVIDENCE_MAX_QUERY_CHARS) {
    return stripped.slice(0, WEB_EVIDENCE_MAX_QUERY_CHARS).trim();
  }
  return stripped;
}

function leaksArticleBody(
  claim: string,
  article: Pick<CanonicalArticle, "title" | "body">,
): boolean {
  const body = normalizeFactClaim(article.body);
  const title = normalizeFactClaim(article.title);
  const combined = normalizeFactClaim(`${article.title}\n${article.body}`);
  if (claim === body || claim === combined || claim === `${title} ${body}`) {
    return true;
  }
  if (body.length >= 40 && claim.length >= Math.min(body.length, 80) && body.startsWith(claim)) {
    return claim.length >= 80;
  }
  return false;
}
