import { createServer } from "node:http";
import { join } from "node:path";
import { defineAgent } from "../../../application/dist/index.js";
import { FileSessionStore } from "../../../session/dist/file-store.js";
import { OpenAIChatCompletionsModel } from "../../../providers/openai-compatible/dist/index.js";
import { BasicTracer, DiagnosticsStore } from "../../../observability/dist/index.js";
import { createApplicationAgent } from "../../dist/index.js";
import { CoordinationWorker } from "../../dist/remote-worker.js";

const directory = process.argv[2];
const diagnostics = new DiagnosticsStore();
const tracer = new BasicTracer({ processor: diagnostics, observer: diagnostics });
const model = new OpenAIChatCompletionsModel({ apiKey: "local-protocol-test", model: "local-service", baseURL: process.argv[3] });
const agent = createApplicationAgent({ version: "v1", store: new FileSessionStore(join(directory, "sessions")),
  definition: defineAgent({ model, tracer, permissionPolicy: () => "deny" }) });
const worker = await CoordinationWorker.open({ directory: join(directory, "worker"), token: process.env.MAY_CORRELATION_WORKER_TOKEN,
  agents: { worker: agent }, authorize: ({ agent }) => agent === "worker", maxConcurrent: 1 });
const server = createServer(worker.handle);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.send({ type: "ready", port: server.address().port });
process.on("message", async message => {
  if (message === "diagnostics") {
    process.send({ type: "diagnostics", value: diagnostics.getDiagnostics({ limit: 500 }) });
    return;
  }
  if (message === "close") {
    server.close();
    await worker.close();
    server.closeAllConnections();
    process.disconnect();
  }
});
