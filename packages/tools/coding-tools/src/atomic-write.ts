import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Commit complete contents, never truncate the destination on cancellation. */
export async function atomicWriteText(path: string, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const mode = await stat(path).then((info) => info.mode & 0o777, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", mode ?? 0o666);
    try {
      await file.writeFile(text, { encoding: "utf8", signal });
      if (mode !== undefined) await file.chmod(mode);
      await file.sync();
    } finally { await file.close(); }
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
