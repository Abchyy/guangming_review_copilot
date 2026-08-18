import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { applyOfflineTestEnv } from "./helpers/offline-env";
import { installOfflineNetworkGuard } from "./helpers/offline-network-guard";

applyOfflineTestEnv();
installOfflineNetworkGuard();

beforeEach(() => {
  applyOfflineTestEnv();
});

afterEach(() => {
  cleanup();
});
