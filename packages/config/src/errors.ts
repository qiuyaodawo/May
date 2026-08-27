export class MayConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class MayConfigFileError extends MayConfigError {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      "MAY_CONFIG_FILE_ERROR",
      `Unable to read May config at ${path}`,
      options,
    );
    this.path = path;
  }
}

export class MayConfigParseError extends MayConfigError {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      "MAY_CONFIG_PARSE_ERROR",
      `May config at ${path} is not valid JSON`,
      options,
    );
    this.path = path;
  }
}

export class MayConfigValidationError extends MayConfigError {
  readonly path: string;
  readonly field: string;

  constructor(path: string, field: string, problem: string) {
    super(
      "MAY_CONFIG_VALIDATION_ERROR",
      `Invalid May config at ${path}: ${field} ${problem}`,
    );
    this.path = path;
    this.field = field;
  }
}

export class MayConfigResolutionError extends MayConfigError {
  constructor(message: string) {
    super("MAY_CONFIG_RESOLUTION_ERROR", message);
  }
}
