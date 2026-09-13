import {
  ModelProtocolError,
  RunCancelledError,
  type AssistantMessage,
  type Message,
  type Model,
} from "@may/core";

import type { ContextSummarizer } from "./summary-tail.js";

export interface ModelContextSummarizerOptions {
  /** System instructions that define the required summary. */
  readonly instructions: string;
  /** Final user request that asks the model to produce the summary. */
  readonly requestText: string;
}

/**
 * Create a tool-free context summarizer backed by a May model.
 *
 * Prompt policy remains application-owned: callers must provide both the
 * instructions and the final request text.
 */
export function createModelContextSummarizer(
  model: Model,
  options: Readonly<ModelContextSummarizerOptions>,
): ContextSummarizer {
  const instructions = nonEmpty(options.instructions, "instructions");
  const requestText = nonEmpty(options.requestText, "requestText");

  return {
    async summarize(request): Promise<string> {
      const signal = request.signal ?? new AbortController().signal;
      throwIfCancelled(signal);

      const messages: Message[] = [
        {
          role: "system",
          content: [{ type: "text", text: instructions }],
        },
        ...request.messages,
        {
          role: "user",
          content: [{ type: "text", text: requestText }],
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
        throwIfCancelled(signal);
      } catch (error) {
        if (signal.aborted && (error === signal.reason || error instanceof RunCancelledError || error instanceof Error && error.name === "AbortError")) {
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

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${name} cannot be empty`);
  }
  return value;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunCancelledError(cancellationReason(signal.reason));
  }
}

function cancellationReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  return reason instanceof Error ? reason.message : undefined;
}
