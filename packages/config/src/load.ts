import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MayConfigFileError,
  MayConfigParseError,
} from "./errors.js";
import { parseMayConfig } from "./parse.js";
import type { LoadMayConfigOptions, MayConfig } from "./types.js";

export function getDefaultMayConfigPath(): string {
  return join(homedir(), ".may", "config.json");
}

export async function loadMayConfig(
  options: LoadMayConfigOptions = {},
): Promise<MayConfig> {
  const path = options.path === undefined
    ? getDefaultMayConfigPath()
    : resolve(options.path);
  let source: string;

  try {
    source = await readFile(path, "utf8");
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
