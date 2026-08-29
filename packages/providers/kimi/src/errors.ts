export class KimiError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class KimiApiError extends KimiError {
  readonly status: number;
  readonly providerType: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    status: number;
    message: string;
    providerType?: string;
    retryAfterMs?: number;
  }) {
    super("KIMI_API_ERROR", options.message);
    this.status = options.status;
    this.providerType = options.providerType;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class KimiProtocolError extends KimiError {
  constructor(message: string, options?: ErrorOptions) {
    super("KIMI_PROTOCOL_ERROR", message, options);
  }
}

export class KimiFinishReasonError extends KimiError {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(
      "KIMI_INCOMPLETE_RESPONSE",
      `Kimi stopped with finish reason "${finishReason}"`,
    );
    this.finishReason = finishReason;
  }
}
