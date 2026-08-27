import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import { AnthropicModel } from "../dist/index.js";

const configPath = join(homedir(), ".may", "config.json");

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
    maxTurns: 4,
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
  assert.ok(result.turns >= 2, "the tool loop did not reach a continuation turn");
  assert.ok(
    result.message.content.some(
      (part) => part.type === "text" && part.text.trim() !== "",
    ),
    "Anthropic did not return a final text answer",
  );
});

async function readAnthropicConfig() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read valid JSON from ${configPath}`, {
      cause: error,
    });
  }

  const config = parsed?.providers?.anthropic;
  for (const key of ["apiKey", "baseURL", "model"]) {
    if (typeof config?.[key] !== "string" || config[key].trim() === "") {
      throw new Error(`Set providers.anthropic.${key} in ${configPath}`);
    }
  }

  return config;
}
