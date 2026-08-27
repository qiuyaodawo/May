import { MayError } from "@may/core";

export class PermissionDeniedError extends MayError {
  readonly toolName: string;

  constructor(toolName: string) {
    super("PERMISSION_DENIED", `Permission denied for tool "${toolName}"`);
    this.toolName = toolName;
  }
}

export class PermissionExecutorClosedError extends MayError {
  constructor(reason?: string) {
    super(
      "PERMISSION_EXECUTOR_CLOSED",
      reason ?? "Permission executor is closed",
    );
  }
}
