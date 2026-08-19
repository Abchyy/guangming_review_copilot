export class HoldoutProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HoldoutProtocolError";
  }
}

export function protocolErrorFrom(error: unknown, fallback: string): HoldoutProtocolError {
  if (error instanceof HoldoutProtocolError) {
    return error;
  }
  const message = error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
  return new HoldoutProtocolError(message, { cause: error });
}
