/**
 * Stable error envelope shared by every endpoint. The Web worker maps the code
 * into a customer-facing message, mirroring the existing API error convention.
 */
export interface ServiceErrorEnvelope {
  schemaVersion: "error-1.0";
  code: string;
  message: string;
  diagnostics?: unknown[];
}

export class CodedServiceError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: string,
    message: string,
    statusCode = 400,
    readonly diagnostics?: unknown[],
  ) {
    super(message);
    this.name = "CodedServiceError";
    this.statusCode = statusCode;
  }
}
