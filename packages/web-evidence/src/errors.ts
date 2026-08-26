export class SearchProviderTimeoutError extends Error {
  readonly code = "timeout" as const;

  constructor(message = "Search provider timed out") {
    super(message);
    this.name = "SearchProviderTimeoutError";
  }
}

export class SearchProviderFailureError extends Error {
  readonly code = "provider_failure" as const;

  constructor(message = "Search provider failed") {
    super(message);
    this.name = "SearchProviderFailureError";
  }
}
