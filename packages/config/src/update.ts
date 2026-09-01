import {
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  MayConfigFileError,
  MayConfigParseError,
  MayConfigWriteError,
} from "./errors.js";
import { parseMayConfig } from "./parse.js";
import type { MayConfig } from "./types.js";

/** Atomically updates only the top-level defaultModel field. */
export async function updateDefaultMayModel(
  configPath: string,
  profile: string,
): Promise<MayConfig> {
  const path = resolve(configPath);
  const { source, information } = await readConfigSnapshot(path);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new MayConfigParseError(path, { cause: error });
  }

  parseMayConfig(value, path);
  const updatedValue = {
    ...(value as Record<string, unknown>),
    defaultModel: profile,
  };
  const updated = parseMayConfig(updatedValue, path);
  const output = serializeLike(source, updatedValue);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, output, {
      encoding: "utf8",
      flag: "wx",
      mode: information.mode,
    });
    const current = await stat(path);
    if (!sameSnapshot(information, current)) {
      throw new MayConfigWriteError(
        path,
        "the file changed while it was being updated; retry the operation",
      );
    }
    await rename(temporary, path);
    return updated;
  } catch (error) {
    if (error instanceof MayConfigWriteError) throw error;
    throw new MayConfigWriteError(path, undefined, { cause: error });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readConfigSnapshot(path: string): Promise<{
  source: string;
  information: Stats;
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    const source = await handle.readFile("utf8");
    const information = await handle.stat();
    if (!sameSnapshot(before, information)) {
      throw new MayConfigWriteError(
        path,
        "the file changed while it was being read; retry the operation",
      );
    }
    return { source, information };
  } catch (error) {
    if (error instanceof MayConfigWriteError) throw error;
    throw new MayConfigFileError(path, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serializeLike(
  source: string,
  value: Readonly<Record<string, unknown>>,
): string {
  const indentation = /\r?\n([ \t]+)"/u.exec(source)?.[1];
  let output = indentation === undefined
    ? JSON.stringify(value)
    : JSON.stringify(value, null, indentation);
  if (source.includes("\r\n")) output = output.replace(/\n/gu, "\r\n");
  if (/\r?\n$/u.test(source)) {
    output += source.endsWith("\r\n") ? "\r\n" : "\n";
  }
  return output;
}

function sameSnapshot(before: Stats, after: Stats): boolean {
  return before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    (before.ino === 0 || after.ino === 0 || before.ino === after.ino);
}
