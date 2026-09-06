import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateToolNameError,
  InMemoryContext,
  May,
  ToolRegistry,
} from "../dist/index.js";

function tool(name, description = `${name} tool`) {
  return {
    name,
    description,
    inputSchema: { type: "object" },
    async execute(input) {
      return input;
    },
  };
}

test("registers, queries, snapshots, and composes independent registries", async () => {
  const first = tool("first");
  const second = tool("second");
  const base = new ToolRegistry([first]);
  const composed = ToolRegistry.compose(base, [second]);

  assert.equal(base.size, 1);
  assert.deepEqual(base.names(), ["first"]);
  assert.equal(composed.size, 2);
  assert.equal(composed.get("first"), first);
  assert.equal(composed.require("second"), second);
  assert.deepEqual([...composed], [first, second]);
  assert.deepEqual(composed.definitions(), [
    {
      name: "first",
      description: "first tool",
      inputSchema: { type: "object" },
    },
    {
      name: "second",
      description: "second tool",
      inputSchema: { type: "object" },
    },
  ]);

  const clone = composed.clone().register(tool("third"));
  assert.deepEqual(composed.names(), ["first", "second"]);
  assert.deepEqual(clone.names(), ["first", "second", "third"]);

  const runtime = new May({
    model: {
      async *stream(request) {
        assert.deepEqual(request.tools.map(({ name }) => name), ["first", "second"]);
        yield {
          type: "response.completed",
          message: { role: "assistant", content: [] },
        };
      },
    },
    tools: composed,
    context: new InMemoryContext(),
  });
  composed.register(tool("registered_after_runtime_creation"));
  await runtime.run({ input: "run" }).result;
});

test("rejects invalid and duplicate registrations atomically", () => {
  const registry = new ToolRegistry([tool("existing")]);

  assert.throws(
    () => registry.registerAll([tool("new"), tool("existing")]),
    (error) => {
      assert.ok(error instanceof DuplicateToolNameError);
      assert.equal(error.code, "DUPLICATE_TOOL_NAME");
      assert.equal(error.toolName, "existing");
      return true;
    },
  );
  assert.deepEqual(registry.names(), ["existing"]);

  assert.throws(
    () => ToolRegistry.compose([tool("same")], [tool("same")]),
    /Duplicate tool name: same/,
  );
  assert.throws(
    () => registry.register(tool(" padded ")),
    /tool name must not have surrounding whitespace/,
  );
  assert.deepEqual(registry.names(), ["existing"]);

  const mutable = tool("stable");
  const guarded = new ToolRegistry([mutable]);
  mutable.name = "changed";
  assert.deepEqual(guarded.names(), ["stable"]);
  assert.throws(
    () => guarded.values(),
    /Tool "stable" changed after it was registered/,
  );
});

test("model-side tool definition mutation does not affect a later step", async () => {
  const requests = [];
  const runtime = new May({
    model: {
      async *stream(request) {
        requests.push(request.tools.map(({ name }) => name));
        if (requests.length === 1) {
          request.tools[0].name = "tampered";
          request.tools.splice(0);
          yield {
            type: "response.completed",
            message: {
              role: "assistant",
              content: [],
              toolCalls: [{ id: "call_first", name: "first", input: {} }],
            },
          };
          return;
        }
        yield {
          type: "response.completed",
          message: { role: "assistant", content: [] },
        };
      },
    },
    tools: [tool("first")],
    context: new InMemoryContext(),
  });

  await runtime.run({ input: "run" }).result;

  assert.deepEqual(requests, [["first"], ["first"]]);
});


test("captures a dynamic catalog once per Run, including nested schemas and execution", async () => {
  let sources = 0;
  let dynamic = { ...tool("remote", "version one"), permissionVersion: "one",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    async execute() { return "one"; },
  };
  let catalog = [dynamic];
  const outputs = [];
  const seen = [];
  const runtime = new May({
    context: new InMemoryContext(),
    toolSource: () => { sources++; return catalog; },
    toolExecutor: { async execute({ tool, input, context }) {
      outputs.push([tool.permissionVersion, await tool.execute(input, context)]);
      return outputs.at(-1);
    } },
    model: { async *stream(request, { step }) {
      seen.push(request.tools[0]?.description);
      if (sources === 1 && step === 1) {
        // Both catalog publication and external nested mutation happen mid-Run.
        catalog = [{ ...dynamic, description: "version two", permissionVersion: "two",
          async execute() { return "two"; } }];
        dynamic.inputSchema.properties.value.type = "number";
        dynamic.execute = async () => "tampered";
        request.tools[0].inputSchema.properties.value.type = "boolean";
      }
      if (sources === 1 && step === 2) {
        assert.equal(request.tools[0].inputSchema.properties.value.type, "string");
      }
      yield { type: "response.completed", message: { role: "assistant", content: [],
        ...(step === 1 ? { toolCalls: [{ id: "remote-call", name: "remote", input: {} }] } : {}),
      } };
    } },
  });
  await runtime.run({ input: "first" }).result;
  await runtime.continue().result;
  assert.equal(sources, 2);
  assert.deepEqual(seen, ["version one", "version one", "version two", "version two"]);
  assert.deepEqual(outputs, [["one", "one"], ["two", "two"]]);
  catalog = [tool("duplicate"), tool("duplicate")];
  assert.throws(() => runtime.run({ input: "invalid" }), DuplicateToolNameError);
  catalog = [];
  await runtime.run({ input: "not stuck" }).result;
});
