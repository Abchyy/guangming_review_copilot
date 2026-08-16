import { getReviewDatabase } from "@/lib/server/db";
import { ReviewStore } from "@/lib/server/review-store";

let store: ReviewStore | undefined;

export function getReviewStore(): ReviewStore {
  if (!store) {
    store = new ReviewStore(getReviewDatabase());
  }
  return store;
}

export function setReviewStoreForTests(next: ReviewStore | undefined): void {
  store = next;
}
