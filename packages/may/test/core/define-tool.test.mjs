import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineTool, ToolInputValidationError } from "../../dist/core/index.js";

test("defineTool converts input schemas and awaits defaults and transforms", async () => {
  const tool = defineTool({
    name: "transform",
    description: "Transform a default value",
    schema: z.object({
      count: z
        .number()
        .default(2)
        .transform(async (value) => value + 1),
    }),
    async execute(input) {
      return input.count;
    },
  });
  assert.equal(tool.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(tool.inputSchema.properties.count.type, "number");
  assert.deepEqual(await tool.parse({}), { count: 3 });
  await assert.rejects(tool.parse({ count: "invalid" }), (error) => {
    assert.ok(error instanceof ToolInputValidationError);
    assert.deepEqual(error.issues[0].path, ["count"]);
    return true;
  });
});

test("defineTool preserves null and rejects unsupported schema conversion immediately", async () => {
  const tool = defineTool({
    name: "null",
    description: "Return null",
    schema: z.object({}).transform(async () => null),
    async execute(input) {
      return input;
    },
  });
  assert.equal(await tool.parse({}), null);
  assert.throws(() =>
    defineTool({
      name: "date",
      description: "Date",
      schema: z.date(),
      async execute(input) {
        return input;
      },
    }),
  );
});
