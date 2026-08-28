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

  await first.append([message("added")]);

  assert.deepEqual(await first.snapshot(), {
    instructions: "system",
    messages: [message("initial"), message("added")],
    metadata: { workspace: "one" },
  });
  assert.deepEqual(await second.snapshot(), {
    messages: [message("initial")],
  });
  assert.deepEqual(messages, [message("initial")]);
});

function message(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
