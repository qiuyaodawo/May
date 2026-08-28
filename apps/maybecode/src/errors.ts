export class MaybeCodeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaybeCodeUsageError";
  }
}

export class MaybeCodeConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaybeCodeConfigError";
  }
}
