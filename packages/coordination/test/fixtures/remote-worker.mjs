import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { defineAgent } from "../../../application/dist/index.js";
import { FileSessionStore } from "../../../session/dist/file-store.js";
import { createApplicationAgent } from "../../dist/index.js";
import { CoordinationWorker } from "../../dist/remote-worker.js";

const directory = process.argv[2];
const agent = createApplicationAgent({ version: "v1", store: new FileSessionStore(join(directory, "sessions")),
  definition: defineAgent({ permissionPolicy: () => "deny", model: { async *stream(request, options) {
    const input = request.messages.find((message) => message.role === "user").content[0].text;
    await appendFile(join(directory, "calls.log"), `${input}\n`);
    if (input === "slow") await setTimeout(200, undefined, { signal: options.signal });
    if (input === "blocked") await setTimeout(60_000, undefined, { signal: options.signal });
    yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: `Remote: ${input}` }] } };
  } } }),
});
const worker = await CoordinationWorker.open({ directory: join(directory, "worker"), token: process.env.MAY_TEST_WORKER_TOKEN,
  agents: { worker: agent }, authorize: ({ agent, execution }) => agent === "worker" && execution.task.input !== "denied", maxConcurrent: 1,
});
const server = createServer(worker.handle);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.send({ port: server.address().port });
process.on("message", async (message) => {
  if (message !== "close") return;
  server.close(); await worker.close(); server.closeAllConnections(); process.disconnect();
});
