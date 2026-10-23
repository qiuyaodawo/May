import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MaybeCodeStartCommand } from "./args.js";

export async function missingMaybeCodeConfig(command: MaybeCodeStartCommand): Promise<string | undefined> {
  const path = command.configPath === undefined ? join(homedir(), ".may", "config.json") : resolve(command.configPath);
  try { await lstat(path); return undefined; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (command.ui === "web" && !/^[\x21-\x7e]{32,256}$/u.test(process.env.MAYBECODE_CONTROL_TOKEN ?? "")) {
    throw new Error("Set MAYBECODE_CONTROL_TOKEN (32..256 printable ASCII characters) before starting --ui web.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`May config is missing at ${path}. Run maybecode in an interactive terminal to create it, or supply an existing file with --config <path>.`);
  }
  return path;
}
