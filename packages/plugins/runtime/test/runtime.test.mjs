import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import test from "node:test";
import { createRuntimePlugin, createContextPlugin, createContextWrapperPlugin, createToolsPlugin } from "../dist/index.js";
import { PluginHost } from "../../../plugin/dist/index.js";
import { services, ContextWrappers, ToolSources } from "../../../plugin-services/dist/index.js";

test("Runtime, Context and tool factories acquire and release real resources", async () => {
  const resources = [];
  const toolSources = new ToolSources();
  const contextWrappers = new ContextWrappers();
  const host = await PluginHost.create({ plugins: [
    createRuntimePlugin(), createContextPlugin(),
    createContextWrapperPlugin({ id: "verification.context-wrapper", create: () => factory => ({ create: options => factory.create({ ...options, instructions: "plugin instructions" }) }) }),
    createToolsPlugin({ id: "verification.file-tool", async create(context) {
      const handle = await open(new URL("../../../../README.md", import.meta.url), "r");
      resources.push(handle); context.defer(() => handle.close());
      return () => [{ name: "read_file", description: "Read an actual file", inputSchema: { type: "object" }, async execute() { return (await handle.stat()).size; } }];
    } }),
  ], services: [{ service: services.toolSources, value: toolSources }, { service: services.contextWrappers, value: contextWrappers }] });
  const scope = await host.createScope("application", { id: "verification" });
  assert.equal(typeof scope.get(services.runtimeFactory), "function");
  const context = contextWrappers.apply(scope.get(services.contextFactory)).create({});
  assert.equal((await context.context.snapshot()).instructions, "plugin instructions");
  assert.ok(await toolSources.snapshot().require("read_file").execute({}) > 0);
  await host.close();
  assert.equal(resources[0].fd, -1);
  assert.equal(toolSources.snapshot().size, 0);
  assert.equal((await contextWrappers.apply(new (await import("../../../context/dist/index.js")).InMemoryContextFactory()).create({}).context.snapshot()).instructions, undefined);
});
