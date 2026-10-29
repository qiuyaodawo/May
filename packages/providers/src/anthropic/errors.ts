export class AnthropicError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AnthropicApiError extends AnthropicError {
  readonly status: number;
  readonly providerType: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    status: number;
    message: string;
    providerType?: string;
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super("ANTHROPIC_API_ERROR", options.message);
    this.status = options.status;
    this.providerType = options.providerType;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class AnthropicStreamError extends AnthropicError {
  readonly providerType: string | undefined;
  readonly requestId: string | undefined;

  constructor(options: {
    message: string;
    providerType?: string;
    requestId?: string;
  }) {
    super("ANTHROPIC_STREAM_ERROR", options.message);
    this.providerType = options.providerType;
    this.requestId = options.requestId;
  }
}

export class AnthropicProtocolError extends AnthropicError {
  constructor(message: string, options?: ErrorOptions) {
    super("ANTHROPIC_PROTOCOL_ERROR", message, options);
  }
}

export class AnthropicFinishReasonError extends AnthropicError {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(
      "ANTHROPIC_INCOMPLETE_RESPONSE",
      `Anthropic stopped with finish reason "${finishReason}"`,
    );
    this.finishReason = finishReason;
  }
}
