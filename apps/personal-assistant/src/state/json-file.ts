import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { isMissing } from "../vault/paths.js";

/**
 * 单文件 JSON 状态：先写临时文件再改名，避免进程中断留下半个文件。
 * 所有修改串行执行，调用方拿到的是修改后的完整状态。
 */
export class JsonFile<T> {
  private current: T;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly path: string,
    state: T,
  ) {
    this.current = state;
  }

  static async open<T>(
    path: string,
    create: () => T,
    validate: (value: unknown) => T,
  ): Promise<JsonFile<T>> {
    await mkdir(dirname(path), { recursive: true });
    let state: T;
    try {
      state = validate(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      state = create();
      const file = new JsonFile(path, state);
      await file.persist();
      return file;
    }
    return new JsonFile(path, state);
  }

  read(): T {
    return this.current;
  }

  /**
   * 串行修改并落盘。回调根据当前状态返回新状态，落盘成功后返回新状态。
   * 回调必须是纯函数，不得在内部再次修改本文件。
   */
  update<TNext extends T>(change: (current: T) => TNext): Promise<TNext> {
    const job = this.tail.then(async () => {
      const next = change(this.current);
      this.current = next;
      await this.persist();
      return next;
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.pending`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.current, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
