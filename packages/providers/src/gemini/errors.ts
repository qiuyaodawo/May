/** @experimental */
export class GeminiProtocolError extends Error {
  readonly code = "GEMINI_PROTOCOL_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GeminiProtocolError";
  }
}

/** @experimental */
export class GeminiApiError extends Error {
  readonly code = "GEMINI_API_ERROR";
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

/** @experimental */
export class GeminiFinishReasonError extends Error {
  readonly code = "GEMINI_INCOMPLETE_RESPONSE";
  constructor(readonly finishReason: string) {
    super(`Gemini stopped with finish reason "${finishReason}"`);
    this.name = "GeminiFinishReasonError";
  }
}
