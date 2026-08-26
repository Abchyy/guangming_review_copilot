export class SpecialistTimeoutError extends Error {
  readonly code = "timed_out" as const;

  constructor(message = "Specialist timed out") {
    super(message);
    this.name = "SpecialistTimeoutError";
  }
}

export class SpecialistExecutionError extends Error {
  readonly code = "failed" as const;

  constructor(message = "Specialist failed") {
    super(message);
    this.name = "SpecialistExecutionError";
  }
}
