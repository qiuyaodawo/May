export class MaybeCodeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaybeCodeUsageError";
  }
}

export { MaybeCodeConfigError } from "@may/plugin-delegation";
