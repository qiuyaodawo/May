import { InMemoryContext, May } from "@may/core";

let step = 0;

const model = {
  async *stream(request) {
    step += 1;

    if (step === 1) {
      yield { type: "text.delta", delta: "让我计算一下……" };
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [],
          toolCalls: [
            { id: "call_add", name: "add", input: { a: 20, b: 22 } },
          ],
        },
      };
      return;
    }

    const toolResult = request.messages.at(-1).content[0].value;
    yield {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `结果是 ${toolResult}` }],
      },
    };
  },
};

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
  async execute({ a, b }) {
    return a + b;
  },
};

const may = new May({
  model,
  tools: [add],
  context: new InMemoryContext({
    instructions: "You are May, a concise assistant.",
  }),
});

const run = may.run({ input: "20 + 22 等于多少？" });

for await (const event of run.events) {
  if (event.type === "model.text.delta") {
    process.stdout.write(event.delta);
  } else {
    console.log("\n", event.type);
  }
}

const result = await run.result;
console.log("\nFinal:", result.message.content[0].text);
