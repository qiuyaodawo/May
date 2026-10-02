import type { EnvironmentProcessResult } from "./types.js";

export type EnvironmentErrorCode =
  | "ENVIRONMENT_INVALID_OPTION"
  | "ENVIRONMENT_INVALID_PATH"
  | "ENVIRONMENT_PATH_NOT_FOUND"
  | "ENVIRONMENT_PATH_NOT_A_FILE"
  | "ENVIRONMENT_PATH_NOT_A_DIRECTORY"
  | "ENVIRONMENT_PATH_NOT_EMPTY"
  | "ENVIRONMENT_PATH_UNSUPPORTED"
  | "ENVIRONMENT_PATH_FORBIDDEN"
  | "ENVIRONMENT_PATH_EXISTS"
  | "ENVIRONMENT_OUTPUT_TOO_LARGE"
  | "ENVIRONMENT_INVALID_UTF8"
  | "ENVIRONMENT_INVALID_RESULT"
  | "ENVIRONMENT_INITIALIZATION_FAILED"
  | "ENVIRONMENT_CLOSED"
  | "ENVIRONMENT_CANCELLED"
  | "ENVIRONMENT_UNSUPPORTED_PLATFORM"
  | "ENVIRONMENT_PROVIDER_UNAVAILABLE"
  | "ENVIRONMENT_REQUIRED_PROGRAM_MISSING"
  | "ENVIRONMENT_REQUIRED_PROGRAM_MISMATCH"
  | "ENVIRONMENT_PROCESS_START_FAILED"
  | "ENVIRONMENT_PROCESS_LIMIT_REACHED"
  | "ENVIRONMENT_PROCESS_CANCELLED"
  | "ENVIRONMENT_PROCESS_CANCEL_UNCONFIRMED"
  | "ENVIRONMENT_PROCESS_TIMEOUT"
  | "ENVIRONMENT_ARTIFACT_MISMATCH"
  | "ENVIRONMENT_EXPORT_DESTINATION_EXISTS";

export class EnvironmentError extends Error {
  readonly code: EnvironmentErrorCode;

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentError";
    this.code = code;
  }
}

/** 取消后的进程错误，携带已产生的真实输出。 */
export class EnvironmentProcessCancelledError extends EnvironmentError {
  readonly partial: EnvironmentProcessResult;

  constructor(
    message: string,
    partial: EnvironmentProcessResult,
    options?: ErrorOptions,
  ) {
    super("ENVIRONMENT_PROCESS_CANCELLED", message, options);
    this.name = "EnvironmentProcessCancelledError";
    this.partial = partial;
  }
}

/** 超时停止后的进程错误，携带已产生的真实输出。 */
export class EnvironmentProcessTimeoutError extends EnvironmentError {
  readonly partial: EnvironmentProcessResult;

  constructor(
    message: string,
    partial: EnvironmentProcessResult,
    options?: ErrorOptions,
  ) {
    super("ENVIRONMENT_PROCESS_TIMEOUT", message, options);
    this.name = "EnvironmentProcessTimeoutError";
    this.partial = partial;
  }
}