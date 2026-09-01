import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import {
  createCodingTool,
  createCodingTools,
  createReadOnlyTools,
} from "../dist/index.js";
import { createWorkspace } from "./helpers.mjs";

test("creates individual, coding, and read-only tool sets", async (t) => {
  const cwd = await createWorkspace(t);

  assert.equal(createCodingTool("edit", { cwd }).name, "edit");
  assert.deepEqual(
    createCodingTools({ cwd }).map((tool) => tool.name),
    ["read", "shell", "edit", "write"],
  );
  assert.deepEqual(
    createReadOnlyTools({ cwd }).map((tool) => tool.name),
    ["read"],
  );
});

test("registers a created read tool in a May tool loop", async (t) => {
  const cwd = await createWorkspace(t);
  await writeFile(join(cwd, "message.txt"), "hello from the workspace");
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{
              id: "call_read",
              name: "read",
              input: { path: "message.txt" },
            }],
          },
        };
        return;
      }

      const toolOutput = request.messages.at(-1).content[0].value;
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: toolOutput.content }],
        },
      };
    },
  };
  const run = new May({
    model,
    context: new InMemoryContext(),
    tools: createReadOnlyTools({ cwd }),
  }).run({ input: "Read message.txt" });

  const result = await run.result;

  assert.equal(result.steps, 2);
  assert.equal(result.message.content[0].text, "hello from the workspace");
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["read"]);
});
