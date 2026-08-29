export class OpenAIResponsesError extends Error {
  readonly status: number | undefined;
  readonly providerType: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      providerType?: string;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "OpenAIResponsesError";
    this.status = options.status;
    this.providerType = options.providerType;
    this.requestId = options.requestId;
  }
}

export class OpenAIResponsesProtocolError extends OpenAIResponsesError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "OpenAIResponsesProtocolError";
  }
}
