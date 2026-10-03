export class MaybeCodeConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaybeCodeConfigError";
  }
}
