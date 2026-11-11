/** @experimental */
export class LspTimeoutError extends Error {
  override name = "LspTimeoutError";
}
/** @experimental */
export class LspServerNotFoundError extends Error {
  override name = "LspServerNotFoundError";
}
/** @experimental */
export class LspServerExitedError extends Error {
  override name = "LspServerExitedError";
}
/** @experimental */
export class LspRenameConflictError extends Error {
  override name = "LspRenameConflictError";
}
/** @experimental */
export class LspRenameWriteError extends Error {
  override name = "LspRenameWriteError";
}
/** @experimental */
export class LspProtocolError extends Error {
  override name = "LspProtocolError";
}
