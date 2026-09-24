import { setTimeout as delay } from "node:timers/promises";

export async function waitForTerminalRun(app, signal) {
  const deadline = Date.now() + 10_000;
  while (app.isRunning) {
    if (Date.now() >= deadline) throw new Error("终端测试等待运行结束超时");
    await delay(1, undefined, { signal });
  }
  signal?.throwIfAborted();
}
