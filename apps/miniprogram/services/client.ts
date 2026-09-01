import { API_BASE_URL, CLIENT_MODE } from "../config";
import { FixtureReviewClient, isFixtureScenario, type FixtureScenario } from "./fixture-client";
import type { ReviewClient } from "./types";
import { WechatApiClient } from "./wechat-api-client";

export type ConfiguredClient = {
  mode: typeof CLIENT_MODE;
  client: ReviewClient;
  fixture: FixtureReviewClient | null;
};

export function createReviewClient(scenario: FixtureScenario = "success"): ConfiguredClient {
  if (CLIENT_MODE === "fixture") {
    const resolved = isFixtureScenario(scenario) ? scenario : "success";
    const fixture = new FixtureReviewClient(resolved);
    return { mode: CLIENT_MODE, client: fixture, fixture };
  }
  return { mode: CLIENT_MODE, client: new WechatApiClient(API_BASE_URL), fixture: null };
}
