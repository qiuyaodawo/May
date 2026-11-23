import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withFileAccess } from "../storage/index.js";
import { MayConfigFileError, MayConfigParseError } from "./errors.js";
import { parseMayConfig } from "./parse.js";
import { resolveMayConfigTargetPath } from "./target-path.js";
import type { LoadMayConfigOptions, MayConfig } from "./types.js";

/** @experimental */
export function getDefaultMayConfigPath(): string {
  return join(homedir(), ".may", "config.json");
}

/** @experimental */
export async function loadMayConfig(options: LoadMayConfigOptions = {}): Promise<MayConfig> {
  const path = options.path === undefined ? getDefaultMayConfigPath() : resolve(options.path);
  let source: string;

  try {
    const targetPath = await resolveMayConfigTargetPath(path);
    source = await withFileAccess(targetPath, "shared", () => readFile(targetPath, "utf8"));
  } catch (error) {
    throw new MayConfigFileError(path, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new MayConfigParseError(path, { cause: error });
  }

  return parseMayConfig(value, path);
}
