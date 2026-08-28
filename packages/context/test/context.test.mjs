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
    effectiveTokens: Math.ceil((6 + messageBytes) / 4),
    measurementMethod: "estimated",
  });
});

test("combines measured input usage with an estimated context tail", async () => {
  const initial = message("initial");
  const tail = message("tail");
  const managed = new InMemoryContextFactory().create({
    messages: [initial, tail],
    budget: { contextWindowTokens: 1000, outputReserveTokens: 100 },
    measurement: { inputTokens: 120, contextMessageCount: 1 },
  });

  const inspection = await managed.controller.inspect();
  const estimatedTailTokens = Math.ceil(byteLength(tail) / 4);
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.measuredInputTokens, 120);
  assert.equal(inspection.estimatedTailTokens, estimatedTailTokens);
  assert.equal(inspection.effectiveTokens, 120 + estimatedTailTokens);
  assert.equal(inspection.contextWindowTokens, 1000);
  assert.equal(inspection.remainingTokens, 1000 - inspection.effectiveTokens);
  assert.equal(inspection.usageRatio, inspection.effectiveTokens / 1000);
});

test("updates the measurement from model usage", async () => {
  const managed = new InMemoryContextFactory().create({
    messages: [message("input")],
  });
  managed.controller.recordModelUsage({ inputTokens: 80 }, 1);
  await managed.context.append([message("new tail")]);

  const inspection = await managed.controller.inspect();
  assert.equal(inspection.measurementMethod, "measured+estimated");
  assert.equal(inspection.measuredInputTokens, 80);
  assert.equal(
    inspection.effectiveTokens,
    80 + Math.ceil(byteLength(message("new tail")) / 4),
  );
});

function message(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
