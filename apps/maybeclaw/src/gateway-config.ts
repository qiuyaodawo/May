import { readFile } from "node:fs/promises";
import { withFileAccess } from "@sortedyuan/may/storage";
import { resolveConfigTargetPath, writeDurableIfUnchanged } from "./config-file-write.js";

const writes = new Map<string, Promise<unknown>>();
let enqueueChain: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withGatewayConfiguration<T>(
  path: string,
  action: (raw: Record<string, unknown>, save: () => Promise<void>) => Promise<T>,
): Promise<T> {
  // Reserve enqueue order synchronously before async canonical-path resolution so
  // concurrent callers always execute in strict FIFO call order (even across symlinks).
  const priorEnqueue = enqueueChain;
  let releaseEnqueue: () => void = () => {};
  enqueueChain = new Promise<void>((resolve) => {
    releaseEnqueue = resolve;
  });
  return (async () => {
    let key: string;
    let job: Promise<T>;
    let settled: Promise<void>;
    try {
      await priorEnqueue;
      key = await resolveConfigTargetPath(path);
      job = (writes.get(key) ?? Promise.resolve()).then(() =>
        withFileAccess(key, "exclusive", async () => {
          const original = await readFile(key, "utf8");
          let config: unknown;
          try {
            config = JSON.parse(original);
          } catch {
            throw new Error("配置文件需要有效的 JSON。");
          }
          if (!isRecord(config) || !isRecord(config.apps) || !isRecord(config.apps.maybeclaw)) {
            throw new Error("MaybeClaw 配置不存在。");
          }
          return action(config.apps.maybeclaw, async () => {
            const serialized = JSON.stringify(config, null, 2) + "\n";
            await writeDurableIfUnchanged(key, serialized, async () => {
              if ((await readFile(key, "utf8")) !== original) {
                throw new Error("配置已被其他操作修改，请刷新后重试。");
              }
            });
          });
        }),
      );
      settled = job.then(
        () => {},
        () => {},
      );
      writes.set(key, settled);
    } finally {
      releaseEnqueue();
    }
    return job.finally(() => {
      if (writes.get(key) === settled) writes.delete(key);
    });
  })();
}
