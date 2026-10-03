import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineService, PluginHost } from "@may/plugin";
import { defineHook } from "@may/core";
import { services } from "@may/plugin-services";
import { createRuntimePlugin, createContextPlugin } from "@may/plugin-runtime";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { createGatewayRpcAdapter } from "@may/plugin-agent-adapters";

const service = defineService({ id: "consumer.counter", version: "1.0.0", scope: "application" });
const hook = defineHook({
  name: "consumer.increment",
  kind: "transform",
  validate(value) {
    assert.equal(typeof value, "number");
    return value;
  },
});
const host = await PluginHost.create({ hooks: [hook], plugins: [
  {
    id: "counter", version: "1.0.0", provides: [service],
    setup(ctx) { ctx.provide(service, { value: 2 }); },
  },
  {
    id: "add", version: "1.0.0", requires: [{ service }],
    setup(ctx) { ctx.on(hook, (value) => value + ctx.get(service).value); },
  },
] });
const application = await host.createScope("application", { id: "external" });
assert.equal(await application.transform(hook, 5, { signal: new AbortController().signal }), 7);
await host.close();
for (const name of ["models", "skills", "goals", "history-memory", "delegation", "mcp", "observability", "delivery", "channel-telegram", "channel-feishu", "agent-adapters", "coordination", "web-api"]) {
  const module = await import(`@may/plugin-${name}`);
  assert.ok(Object.keys(module).length > 0, `${name} exports its plugin API`);
}
const foundations = await PluginHost.create({ plugins: [createRuntimePlugin(), createContextPlugin(), createPermissionPlugin({ create: () => () => "allow" })] });
const scope = await foundations.createScope("application", { id: "packaged-foundations" });
assert.equal(typeof scope.get(services.runtimeFactory), "function");
assert.equal(typeof scope.get(services.contextFactory).create, "function");
assert.equal(typeof scope.get(services.permissionPolicy), "function");
await foundations.close();
const directory = fileURLToPath(new URL("./rpc-files/", import.meta.url));
await mkdir(directory, { recursive: true });
const text = "Independent plugin installation";
await writeFile(join(directory, "document.txt"), text);
const rpcOptions = { transport: "stdio", command: process.execPath, args: [
  fileURLToPath(import.meta.resolve("@may/plugin-agent-adapters/examples/rpc-file-agent")),
  "--directory", join(directory, "state"), "--workspace", directory,
] };
let adapter = await createGatewayRpcAdapter("files", rpcOptions);
let conversation;
try {
  conversation = await adapter.createConversation("packaged-document");
  const result = await adapter.execute({ conversationId: conversation, inputId: "document-hash",
    input: { role: "user", content: [{ type: "text", text: JSON.stringify({ operation: "sha256", path: "document.txt" }) }] },
    signal: new AbortController().signal, tools: [], shouldYield: () => false,
    report(event) { throw new Error(`Unexpected file Agent event: ${event.type}`); },
  });
  assert.equal(result.text, createHash("sha256").update(text).digest("hex"));
} finally { await adapter.close(); }
adapter = await createGatewayRpcAdapter("files", rpcOptions);
try { assert.equal((await adapter.inspect(conversation, "document-hash")).status, "completed"); }
finally { await adapter.close(); }
console.log("Packed plugin and complete runtime dependencies imported and executed successfully");
