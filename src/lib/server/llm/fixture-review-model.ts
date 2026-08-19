import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseLlmReviewOutput, type ReviewCandidate, type ReviewExecutionProvenance } from "@/lib/contracts/review";
import { applicationCacheProvenance } from "@/lib/server/llm/provenance";
import type { ReviewModel } from "@/lib/server/llm/review-model";
import { canonicalWorkspaceRoot } from "@/lib/server/workspace-identity";

function loadDemoCandidates(): ReviewCandidate[] {
  const filePath = join(canonicalWorkspaceRoot(), "data", "fixtures", "demo-candidates.json");
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

  consumeLastProvenance(): ReviewExecutionProvenance {
    return applicationCacheProvenance({
      adapterProvider: this.provider,
      requestedModel: this.model,
      enabled: false,
      hit: false,
    });
  }
}
