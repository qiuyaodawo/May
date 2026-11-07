import { FatalToolExecutionError, MayError } from "../core/index.js";

/** @experimental */
export class PermissionDeniedError extends MayError {
  readonly toolName: string;

  constructor(toolName: string) {
    super("PERMISSION_DENIED", `Permission denied for tool "${toolName}"`);
    this.toolName = toolName;
  }
}

/** @experimental */
export class PermissionExecutorClosedError extends FatalToolExecutionError {
  constructor(reason?: string) {
    super(reason ?? "Permission executor is closed", { code: "PERMISSION_EXECUTOR_CLOSED" });
    this.name = "PermissionExecutorClosedError";
  }
}
