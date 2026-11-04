import { hasErrorCode } from "@sortedyuan/may/storage";

export function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}
