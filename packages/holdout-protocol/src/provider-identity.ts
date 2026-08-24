import {
  canonicalizeProviderEndpoint,
  observeOfficialAccountBoundaryId,
  observeOfficialProviderEndpoint,
  providerAccountBoundaryId,
} from "@grc/providers";

import { HoldoutProtocolError, protocolErrorFrom } from "./errors";

export {
  canonicalizeProviderEndpoint,
  observeOfficialAccountBoundaryId,
  observeOfficialProviderEndpoint,
  providerAccountBoundaryId,
};

export type OfficialProviderBoundary = {
  provider_endpoint: string;
  account_boundary_id: string;
};

export function observeOfficialProviderBoundary(): OfficialProviderBoundary {
  try {
    return {
      provider_endpoint: observeOfficialProviderEndpoint(),
      account_boundary_id: observeOfficialAccountBoundaryId(),
    };
  } catch (error) {
    throw protocolErrorFrom(error, "Official provider boundary observation failed");
  }
}

export function assertArtifactContainsNoSecrets(value: unknown, secrets: Array<string | undefined>): void {
  const dumped = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && secret.length > 0 && dumped.includes(secret)) {
      throw new HoldoutProtocolError("Refusing to persist secret material in a freeze artifact");
    }
  }
}
