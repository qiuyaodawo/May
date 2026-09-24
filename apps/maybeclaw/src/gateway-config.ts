import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const writes = new Map<string, Promise<unknown>>();

export function withGatewayConfiguration<T>(path: string, action: (raw: Record<string, any>, save: () => Promise<void>) => Promise<T>): Promise<T> {
  const key = resolve(path);
  const job = (writes.get(key) ?? Promise.resolve()).then(async () => {
    const original = await readFile(key, "utf8");
    let config: Record<string, any>;
    try { config = JSON.parse(original); }
    catch { throw new Error("配置文件需要有效的 JSON。"); }
    if (!config?.apps?.maybeclaw) throw new Error("MaybeClaw 配置不存在。");
    return action(config.apps.maybeclaw, async () => {
      const temporary = `${key}.${randomUUID()}.pending`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        if (await readFile(key, "utf8") !== original) throw new Error("配置已被其他操作修改，请刷新后重试。");
        await rename(temporary, key);
      } finally { await rm(temporary, { force: true }); }
    });
  });
  const settled = job.then(() => {}, () => {});
  writes.set(key, settled);
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
  return job;
}
