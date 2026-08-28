import {
  ModelProtocolError,
  RunCancelledError,
  type AssistantMessage,
  type Message,
  type Model,
} from "@may/core";
import type { ContextSummarizer } from "@may/context";

const SUMMARY_INSTRUCTIONS = `Summarize the preceding coding-agent conversation for continuation.
Return only a concise, factual working-state summary. Preserve the user's goals
and constraints, decisions, files changed, commands and test outcomes, current
errors, and remaining work. Do not invent details and do not call tools.`;

export function createModelContextSummarizer(model: Model): ContextSummarizer {
  return {
    async summarize(request): Promise<string> {
      const signal = request.signal ?? new AbortController().signal;
      const messages: Message[] = [
        {
          role: "system",
          content: [{ type: "text", text: SUMMARY_INSTRUCTIONS }],
        },
        ...request.messages,
        {
          role: "user",
          content: [{
            type: "text",
            text: "Produce the continuation summary now.",
          }],
        },
      ];
      let completed: AssistantMessage | undefined;

      try {
        for await (const event of model.stream(
          { messages, tools: [] },
          { signal },
        )) {
          if (event.type !== "response.completed") continue;
          if (completed !== undefined) {
            throw new ModelProtocolError(
              "Summary model emitted more than one completed response",
            );
          }
          completed = event.message;
        }
      } catch (error) {
        if (signal.aborted) {
          throw new RunCancelledError(cancellationReason(signal.reason));
        }
        throw error;
      }

      if (completed === undefined) {
        throw new ModelProtocolError(
          "Summary model ended without a completed response",
        );
      }
      if ((completed.toolCalls?.length ?? 0) > 0) {
        throw new ModelProtocolError("Summary model attempted to call a tool");
      }
      const text = completed.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (text === "") {
        throw new ModelProtocolError("Summary model returned no text");
      }
      return text;
    },
  };
}

function cancellationReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  return reason instanceof Error ? reason.message : undefined;
}
