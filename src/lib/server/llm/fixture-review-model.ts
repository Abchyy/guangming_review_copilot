import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseLlmReviewOutput, type ReviewCandidate } from "@/lib/contracts/review";
import type { ReviewModel } from "@/lib/server/llm/review-model";

function loadDemoCandidates(): ReviewCandidate[] {
  const filePath = join(process.cwd(), "data", "fixtures", "demo-candidates.json");
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return parseLlmReviewOutput(raw).candidates;
}

export class FixtureReviewModel implements ReviewModel {
  readonly provider = "fixture" as const;
  readonly model = null;
  private readonly candidates: ReviewCandidate[];

  constructor(candidates?: ReviewCandidate[]) {
    this.candidates = candidates ?? loadDemoCandidates();
  }

  review(): Promise<ReviewCandidate[]> {
    return Promise.resolve(this.candidates.map((candidate) => structuredClone(candidate)));
  }
}
