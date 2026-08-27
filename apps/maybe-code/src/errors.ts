export class MaybeCodeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaybeCodeUsageError";
  }
}

export class MaybeCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaybeCodeConfigError";
  }
}
