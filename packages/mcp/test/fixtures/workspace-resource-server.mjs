import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const uri = "workspace:///value";
const path = join(process.cwd(), "value.txt");
serveStdio(() => {
  const server = new Server({ name: "workspace-resources", version: "1.0.0" });
  server.registerCapabilities({ resources: { subscribe: true } });
  server.setRequestHandler("resources/list", async () => ({ resources: [{ uri, name: "value.txt" }] }));
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
  server.setRequestHandler("resources/read", async request => {
    if (request.params.uri !== uri) throw new Error("Resource URI is unavailable");
    return { contents: [{ uri, text: await readFile(path, "utf8") }], ttlMs: 0, cacheScope: "private" };
  });
  server.setRequestHandler("resources/subscribe", async request => {
    if (request.params.uri !== uri) throw new Error("Resource URI is unavailable");
    return {};
  });
  server.setRequestHandler("resources/unsubscribe", async () => ({}));
  const watcher = watch(process.cwd(), { persistent: false }, (_event, filename) => {
    if (filename === "value.txt") void server.sendResourceUpdated({ uri });
  });
  server.onclose = () => watcher.close();
  return server;
});
