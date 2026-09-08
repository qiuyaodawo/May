export class MayError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConcurrentRunError extends MayError {
  constructor() {
    super(
      "CONCURRENT_RUN",
      "This May runtime already has an active run",
    );
  }
}

/** Marks a tool or ToolExecutor failure that must terminate the run. */
export class FatalToolExecutionError extends MayError {
  constructor(
    message: string,
    options?: ErrorOptions & { readonly code?: string },
  ) {
    super(options?.code ?? "FATAL_TOOL_EXECUTION", message, options);
  }
}

export class ToolSchedulerError extends MayError {
  constructor(message: string) {
    super("TOOL_SCHEDULER_ERROR", message);
  }
}

export class ModelProtocolError extends MayError {
  constructor(message: string) {
    super("MODEL_PROTOCOL_ERROR", message);
  }
}

export class UnsupportedContentError extends MayError {
  readonly adapter: string;
  readonly contentType: string;
  readonly role: string;

  constructor(adapter: string, contentType: string, role: string) {
    super(
      "UNSUPPORTED_CONTENT",
      `${adapter} does not support ${contentType} content in ${role} messages`,
    );
    this.adapter = adapter;
    this.contentType = contentType;
    this.role = role;
  }
}

export class MaxStepsExceededError extends MayError {
  constructor(maxSteps: number) {
    super("MAX_STEPS_EXCEEDED", `Run exceeded the maximum of ${maxSteps} steps`);
  }
}

export class RunCancelledError extends MayError {
  constructor(reason?: string) {
    super("RUN_CANCELLED", reason ?? "Run was cancelled");
  }
}

/** A failed durable barrier leaves external effects uncertain; reopen the Session. */
export class RunCheckpointError extends MayError {
  constructor(cause: unknown) {
    super("RUN_CHECKPOINT_FAILED", `Run checkpoint failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export class ToolNotFoundError extends MayError {
  constructor(name: string) {
    super("TOOL_NOT_FOUND", `Tool \"${name}\" was not found`);
  }
}
