import { openCodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import { openLanguageServerManager } from "../dist/index.js";
import { join } from "node:path";

const workspace = process.argv[2];
const execution = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
const manager = await openLanguageServerManager({
  execution,
  servers: [{ id: "typescript" }],
  dataDirectory: join(workspace, ".data"),
});
await manager.documentSymbols("b.ts", new AbortController().signal);
const plan = await manager.planRename(
  { path: "a.ts", line: 1, symbol: "greet" },
  "welcome",
  new AbortController().signal,
);
process.send({ ready: true, files: plan.files.map((file) => file.path.relative), serverPid: manager.status()[0].pid });
process.once("message", async () => {
  await manager.executeRename(plan, new AbortController().signal);
  await manager.close();
  await execution.close();
  process.disconnect();
});
