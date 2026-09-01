import assert from "node:assert/strict";
import test from "node:test";

import { loadMayConfig, resolveModelProfile } from "@may/config";
import { InMemoryContext, May } from "@may/core";
import { AnthropicModel } from "../dist/index.js";

test("completes a real Anthropic tool-call loop", { timeout: 120_000 }, async () => {
  const config = await readAnthropicConfig();
  const events = [];
  const model = new AnthropicModel({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    maxTokens: 4096,
  });
  const run = new May({
    model,
    maxSteps: 4,
    context: new InMemoryContext({
      instructions: "You are testing May. Follow the user's tool-use instruction exactly.",
    }),
    tools: [{
      name: "add",
      description: "Add two numbers. Use this whenever the user explicitly requests it.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
      async execute({ a, b }) {
        return a + b;
      },
    }],
  }).run({
    input: "必须调用 add 工具计算 17 加 25；得到工具结果后，用一句话告诉我答案。",
  });

  const collecting = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const result = await run.result;
  await collecting;

  assert.ok(
    events.some((event) => event.type === "tool.completed"),
    "Anthropic did not call the add tool",
  );
  assert.ok(result.steps >= 2, "the tool loop did not reach a continuation step");
  assert.ok(
    result.message.content.some(
      (part) => part.type === "text" && part.text.trim() !== "",
    ),
    "Anthropic did not return a final text answer",
  );
});

async function readAnthropicConfig() {
  const loaded = await loadMayConfig();
  const name = findModelProfile(loaded, "anthropic-messages");
  const resolved = resolveModelProfile(loaded, name);
  const config = { ...resolved.providerConfig, model: resolved.model };
  for (const key of ["apiKey", "model"]) {
    if (typeof config?.[key] !== "string" || config[key].trim() === "") {
      throw new Error(`Configure ${key} for models.${name} in ${loaded.path}`);
    }
  }

  return config;
}

function findModelProfile(config, adapter) {
  const entry = Object.entries(config.models).find(([, profile]) =>
    (profile.adapter ?? config.providers[profile.provider]?.adapter) === adapter
  );
  if (entry === undefined) {
    throw new Error(`Configure a model using adapter ${adapter} in ${config.path}`);
  }
  return entry[0];
}
