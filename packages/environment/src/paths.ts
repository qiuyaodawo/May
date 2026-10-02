import { posix, win32 } from "node:path";
import { EnvironmentError } from "./errors.js";

export interface ResolvedEnvironmentPath {
  readonly relative: string;
  readonly absolute: string;
}

export function resolveEnvironmentPath(
  workingDirectory: string,
  inputPath: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): ResolvedEnvironmentPath {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  if (!api.isAbsolute(workingDirectory)) throw invalidPath("working directory must be absolute");
  const relative = normalizeRelativePath(inputPath, platform);
  return { relative, absolute: api.resolve(workingDirectory, relative) };
}

export function toEnvironmentRelativePath(
  workingDirectory: string,
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platform === "win32" ? win32 : posix;
  if (!api.isAbsolute(workingDirectory) || !api.isAbsolute(absolutePath)) {
    throw invalidPath("working directory and target must be absolute");
  }
  return normalizeRelativePath(api.relative(workingDirectory, absolutePath) || ".", platform);
}

export function normalizeRelativePath(
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = platform === "win32";
  const api = windows ? win32 : posix;
  if (typeof inputPath !== "string" || inputPath === "" || inputPath.includes("\0")) {
    throw invalidPath("path must be a non-empty string without null characters");
  }
  if (api.isAbsolute(inputPath) || (windows && /^[A-Za-z]:/u.test(inputPath))) {
    throw invalidPath(`path must be relative to the working directory: ${inputPath}`);
  }
  if (windows) {
    for (const segment of inputPath.split(/[\\/]/u)) {
      if (segment === "" || segment === "." || segment === "..") continue;
      if (/[<>:"|?*\u0001-\u001f]/u.test(segment) || /[ .]$/u.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment)) {
        throw invalidPath(`path segment is not addressable: ${inputPath}`);
      }
    }
  }
  const normalized = api.normalize(inputPath);
  if (normalized === ".." || normalized.startsWith(`..${api.sep}`) || api.isAbsolute(normalized)) {
    throw invalidPath(`path leaves the working directory: ${inputPath}`);
  }
  const trimmed = normalized === "." ? "." : normalized.replace(windows ? /[\\/]+$/u : /\/+$/u, "");
  return windows ? trimmed.split("\\").join("/") : trimmed;
}

export function joinPath(
  workingDirectory: string,
  relative: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveEnvironmentPath(workingDirectory, relative, { platform }).absolute;
}

function invalidPath(message: string): EnvironmentError {
  return new EnvironmentError("ENVIRONMENT_INVALID_PATH", message);
}
