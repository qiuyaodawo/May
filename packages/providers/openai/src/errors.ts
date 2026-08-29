export class OpenAIResponsesError extends Error {
  readonly status: number | undefined;
  readonly providerType: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      providerType?: string;
      requestId?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "OpenAIResponsesError";
    this.status = options.status;
    this.providerType = options.providerType;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class OpenAIResponsesProtocolError extends OpenAIResponsesError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "OpenAIResponsesProtocolError";
  }
}
