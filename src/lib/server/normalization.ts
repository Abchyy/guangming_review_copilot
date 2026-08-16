/**
 * Minimal canonicalization for M1.
 * Only normalizes newlines. Does not trim, punctuate, or Unicode-normalize.
 */
export function canonicalize(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function canonicalizeArticle(title: string, body: string): {
  title: string;
  body: string;
} {
  return {
    title: canonicalize(title),
    body: canonicalize(body),
  };
}
