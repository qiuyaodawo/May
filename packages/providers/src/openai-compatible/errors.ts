/**
 * Errors from any OpenAI-compatible chat endpoint. `provider` names the dialect, `code` keeps its prefix.
 * @experimental
 */
export class OpenAICompatibleError extends Error {
  readonly code: string;
  readonly provider: string;

  constructor(provider: string, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.provider = provider;
    this.code = code;
  }
}

/** @experimental */
export class OpenAICompatibleApiError extends OpenAICompatibleError {
  readonly status: number;
  readonly providerType: string | undefined;
  readonly providerCode: string | number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    provider: string,
    codePrefix: string,
    options: {
      status: number;
      message: string;
      providerType?: string;
      providerCode?: string | number;
      retryAfterMs?: number;
    },
  ) {
    super(provider, `${codePrefix}_API_ERROR`, options.message);
    this.status = options.status;
    this.providerType = options.providerType;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** @experimental */
export class OpenAICompatibleProtocolError extends OpenAICompatibleError {
  constructor(provider: string, codePrefix: string, message: string, options?: ErrorOptions) {
    super(provider, `${codePrefix}_PROTOCOL_ERROR`, message, options);
  }
}

/** @experimental */
export class OpenAICompatibleFinishReasonError extends OpenAICompatibleError {
  readonly finishReason: string;

  constructor(provider: string, codePrefix: string, finishReason: string) {
    super(provider, `${codePrefix}_INCOMPLETE_RESPONSE`, `${provider} stopped with finish reason "${finishReason}"`);
    this.finishReason = finishReason;
  }
}
