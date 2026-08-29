export class DeepSeekError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class DeepSeekApiError extends DeepSeekError {
  readonly status: number;
  readonly providerType: string | undefined;
  readonly providerCode: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    status: number;
    message: string;
    providerType?: string;
    providerCode?: string;
    retryAfterMs?: number;
  }) {
    super("DEEPSEEK_API_ERROR", options.message);
    this.status = options.status;
    this.providerType = options.providerType;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class DeepSeekProtocolError extends DeepSeekError {
  constructor(message: string, options?: ErrorOptions) {
    super("DEEPSEEK_PROTOCOL_ERROR", message, options);
  }
}

export class DeepSeekFinishReasonError extends DeepSeekError {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(
      "DEEPSEEK_INCOMPLETE_RESPONSE",
      `DeepSeek stopped with finish reason \"${finishReason}\"`,
    );
    this.finishReason = finishReason;
  }
}
