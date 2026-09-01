import {
  PUBLIC_API_ERROR_HTTP_STATUS,
  type PublicApiErrorCode,
} from "@grc/contracts";

export class PublicApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: PublicApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicApiError";
    this.status = PUBLIC_API_ERROR_HTTP_STATUS[code];
  }
}
