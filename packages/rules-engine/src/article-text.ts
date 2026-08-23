import type { ArticleField, CanonicalArticle } from "@grc/contracts";

export function fieldText(article: CanonicalArticle, field: ArticleField): string {
  return field === "title" ? article.title : article.body;
}

export function paragraphIndexAt(text: string, offset: number): number {
  const limit = Math.max(0, Math.min(offset, text.length));
  let index = 0;
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) {
      index += 1;
    }
  }
  return index;
}
