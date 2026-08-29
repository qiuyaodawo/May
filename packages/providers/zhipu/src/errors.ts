export class ZhipuError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ZhipuApiError extends ZhipuError {
  readonly status: number;
  readonly providerCode: string | number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    status: number;
    message: string;
    providerCode?: string | number;
    retryAfterMs?: number;
  }) {
    super("ZHIPU_API_ERROR", options.message);
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ZhipuProtocolError extends ZhipuError {
  constructor(message: string, options?: ErrorOptions) {
    super("ZHIPU_PROTOCOL_ERROR", message, options);
  }
}

export class ZhipuFinishReasonError extends ZhipuError {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(
      "ZHIPU_INCOMPLETE_RESPONSE",
      `Zhipu stopped with finish reason "${finishReason}"`,
    );
    this.finishReason = finishReason;
  }
}
