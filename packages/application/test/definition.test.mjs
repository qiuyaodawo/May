import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentDefinition,
  defineAgent,
} from "../dist/index.js";
import {
  DuplicateToolNameError,
  ToolRegistry,
} from "../../core/dist/index.js";
import { InMemorySessionStore } from "../../session/dist/index.js";

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("AgentDefinition snapshots behavior and reuses it across Sessions", async () => {
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "response.completed",
        message: assistant(`response ${requests.length}`),
      };
    },
  };
  const lookup = {
    name: "lookup",
    description: "Look up a value",
    inputSchema: { type: "object" },
    async execute() {
      return { found: true };
    },
  };
  const tools = new ToolRegistry([lookup]);

  const definition = defineAgent({
    model,
    tools,
    instructions: "Use the lookup tool when needed.",
    permissionPolicy: () => "allow",
  });

  assert.ok(definition instanceof AgentDefinition);
  tools.register({
    name: "added_later",
    description: "This must not change an existing definition",
    inputSchema: { type: "object" },
    async execute() {},
  });

  const firstMetadata = { tenant: "first" };
  const firstContextMetadata = { workspace: "/first" };
  const first = await definition.open({
    store: new InMemorySessionStore(),
    metadata: firstMetadata,
    contextMetadata: firstContextMetadata,
  });
  firstMetadata.tenant = "mutated";
  firstContextMetadata.workspace = "/mutated";
  await (await first.submit({ input: "one" })).result;

  assert.deepEqual(first.metadata, { tenant: "first" });
  assert.equal(requests[0].messages[0].role, "system");
  assert.equal(
    requests[0].messages[0].content[0].text,
    "Use the lookup tool when needed.",
  );
  assert.deepEqual(requests[0].tools.map(({ name }) => name), ["lookup"]);
  assert.deepEqual(requests[0].metadata, { workspace: "/first" });
  await first.close();

  const second = await definition.open({
    store: new InMemorySessionStore(),
    metadata: { tenant: "second" },
    contextMetadata: { workspace: "/second" },
  });
  await (await second.submit({ input: "two" })).result;
  assert.deepEqual(second.metadata, { tenant: "second" });
  assert.deepEqual(requests[1].tools.map(({ name }) => name), ["lookup"]);
  assert.deepEqual(requests[1].metadata, { workspace: "/second" });
  await second.close();
});

test("AgentDefinition keeps Session-bound values out of reusable options", () => {
  const behavior = {
    model: { async *stream() {} },
    permissionPolicy: () => "allow",
  };

  assert.throws(
    () => defineAgent({ ...behavior, metadata: { tenant: "wrong layer" } }),
    /metadata.*Session-bound/u,
  );
  assert.throws(
    () => defineAgent({ ...behavior, store: new InMemorySessionStore() }),
    /store.*Session-bound/u,
  );
  assert.throws(
    () => defineAgent({
      ...behavior,
      tools: [
        {
          name: "duplicate",
          description: "first",
          inputSchema: { type: "object" },
          async execute() {},
        },
        {
          name: "duplicate",
          description: "second",
          inputSchema: { type: "object" },
          async execute() {},
        },
      ],
    }),
    DuplicateToolNameError,
  );
});

test("AgentDefinition forwards its tool scheduler", async () => {
  let modelCall = 0;
  let schedulerCalls = 0;
  const definition = defineAgent({
    model: {
      async *stream() {
        modelCall += 1;
        if (modelCall === 1) {
          yield {
            type: "response.completed",
            message: {
              role: "assistant",
              content: [],
              toolCalls: [{ id: "call_ping", name: "ping", input: {} }],
            },
          };
          return;
        }
        yield {
          type: "response.completed",
          message: assistant("done"),
        };
      },
    },
    tools: [{
      name: "ping",
      description: "Return pong",
      inputSchema: { type: "object" },
      async execute() {
        return "pong";
      },
    }],
    permissionPolicy: () => "allow",
    toolScheduler: {
      async schedule(operations) {
        schedulerCalls += 1;
        const results = [];
        for (const operation of operations) results.push(await operation.execute());
        return results;
      },
    },
  });
  const application = await definition.open({
    store: new InMemorySessionStore(),
  });

  try {
    const result = await (await application.submit({ input: "ping" })).result;
    assert.equal(result.message.content[0].text, "done");
    assert.equal(schedulerCalls, 1);
  } finally {
    await application.close();
  }
});
