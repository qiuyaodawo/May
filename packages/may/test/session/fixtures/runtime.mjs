import { InMemoryContext, May } from "@sortedyuan/may/core";

export function createRuntime() {
  return new May({
    context: new InMemoryContext(),
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistantMessage("ok"),
        };
      },
    },
  });
}

export function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
