export class OpenAIChatCompletionsError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class OpenAIChatCompletionsApiError
  extends OpenAIChatCompletionsError {
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
    super("OPENAI_CHAT_COMPLETIONS_API_ERROR", options.message);
    this.status = options.status;
    this.providerType = options.providerType;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class OpenAIChatCompletionsProtocolError
  extends OpenAIChatCompletionsError {
  constructor(message: string, options?: ErrorOptions) {
    super("OPENAI_CHAT_COMPLETIONS_PROTOCOL_ERROR", message, options);
  }
}

export class OpenAIChatCompletionsFinishReasonError
  extends OpenAIChatCompletionsError {
  readonly finishReason: string;

  constructor(finishReason: string) {
    super(
      "OPENAI_CHAT_COMPLETIONS_INCOMPLETE_RESPONSE",
      `OpenAI-compatible chat completion stopped with finish reason "${finishReason}"`,
    );
    this.finishReason = finishReason;
  }
}
