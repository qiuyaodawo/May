import { InMemoryContext, May } from "@may/core";
import { DeepSeekModel } from "@may/provider-deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error("Set DEEPSEEK_API_KEY before running this example");
}

const add = {
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      typeof input.a !== "number" || typeof input.b !== "number"
    ) {
      throw new TypeError("a and b must be numbers");
    }
    return input;
  },
  async execute({ a, b }) {
    return a + b;
  },
};

const may = new May({
  model: new DeepSeekModel({
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  }),
  tools: [add],
  context: new InMemoryContext({
    instructions: "You are May. Use the provided tools when appropriate.",
  }),
});

const run = may.run({ input: "请使用工具计算 123 加 456。" });

for await (const event of run.events) {
  if (event.type === "model.reasoning.delta") {
    process.stderr.write(event.delta);
  }
  if (event.type === "model.text.delta") {
    process.stdout.write(event.delta);
  }
}

await run.result;
process.stdout.write("\n");
