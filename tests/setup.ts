import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { applyOfflineTestEnv, installOfflineNetworkGuard } from "@grc/test-kit";

applyOfflineTestEnv();
installOfflineNetworkGuard();

beforeEach(() => {
  applyOfflineTestEnv();
});

afterEach(() => {
  cleanup();
});
