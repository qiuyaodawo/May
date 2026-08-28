import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContextFactory } from "../dist/index.js";

test("creates independent in-memory contexts from factory input", async () => {
  const factory = new InMemoryContextFactory();
  const messages = [message("initial")];
  const first = await factory.create({
    instructions: "system",
    messages,
    metadata: { workspace: "one" },
  });
  const second = await factory.create({ messages });

  await first.context.append([message("added")]);

  assert.deepEqual(await first.context.snapshot(), {
    instructions: "system",
    messages: [message("initial"), message("added")],
    metadata: { workspace: "one" },
  });
  assert.deepEqual(await second.context.snapshot(), {
    messages: [message("initial")],
  });
  assert.deepEqual(messages, [message("initial")]);

  const inspection = await first.controller.inspect();
  const messageBytes = byteLength(message("initial")) + byteLength(message("added"));
  assert.deepEqual(inspection, {
    instructionsBytes: 6,
    messageBytes,
    totalBytes: 6 + messageBytes,
    messageCount: 2,
    messagesByRole: { system: 0, user: 2, assistant: 0, tool: 0 },
    toolResultCount: 0,
    estimatedTokens: Math.ceil((6 + messageBytes) / 4),
    tokenEstimateMethod: "utf8-bytes/4",
  });
});

function message(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
