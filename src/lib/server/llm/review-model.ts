import type { CanonicalArticle, ReviewCandidate } from "@/lib/contracts/review";
import type { ReviewProvider } from "@/lib/contracts/review";

export interface ReviewModel {
  readonly provider: ReviewProvider;
  readonly model: string | null;
  review(article: CanonicalArticle): Promise<ReviewCandidate[]>;
}
