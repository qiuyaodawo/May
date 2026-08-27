export class MayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ModelProtocolError extends MayError {
  constructor(message: string) {
    super("MODEL_PROTOCOL_ERROR", message);
  }
}

export class MaxTurnsExceededError extends MayError {
  constructor(maxTurns: number) {
    super("MAX_TURNS_EXCEEDED", `Run exceeded the maximum of ${maxTurns} turns`);
  }
}

export class RunCancelledError extends MayError {
  constructor(reason?: string) {
    super("RUN_CANCELLED", reason ?? "Run was cancelled");
  }
}

export class ToolNotFoundError extends MayError {
  constructor(name: string) {
    super("TOOL_NOT_FOUND", `Tool \"${name}\" was not found`);
  }
}
