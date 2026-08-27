export class CodingToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodingToolError";
    this.code = code;
  }
}
