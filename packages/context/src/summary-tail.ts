import type { ContextSnapshot, Message, SystemMessage } from "@may/core";

import type {
  ContextCompactionOptions,
  ContextCompactionStrategy,
} from "./compaction.js";

export interface ContextSummaryRequest {
  readonly messages: readonly Message[];
  readonly signal?: AbortSignal;
}

export interface ContextSummarizer {
  summarize(request: ContextSummaryRequest): string | Promise<string>;
}

export interface SummaryTailOptions {
  readonly summarizer: ContextSummarizer;
  readonly keepRecentTurns?: number;
  readonly minimumPrefixMessages?: number;
}

export class SummaryTailStrategy implements ContextCompactionStrategy {
  readonly name = "summary-tail";

  private readonly summarizer: ContextSummarizer;
  private readonly keepRecentTurns: number;
  private readonly minimumPrefixMessages: number;

  constructor(options: SummaryTailOptions) {
    this.summarizer = options.summarizer;
    this.keepRecentTurns = positiveInteger(
      options.keepRecentTurns ?? 2,
      "keepRecentTurns",
    );
    this.minimumPrefixMessages = positiveInteger(
      options.minimumPrefixMessages ?? 1,
      "minimumPrefixMessages",
    );
  }

  async compact(
    snapshot: Readonly<ContextSnapshot>,
    options: ContextCompactionOptions = {},
  ): Promise<readonly Message[]> {
    const userIndexes = snapshot.messages
      .map((message, index) => message.role === "user" ? index : undefined)
      .filter((index): index is number => index !== undefined);
    if (userIndexes.length <= this.keepRecentTurns) return snapshot.messages;

    const boundary = userIndexes[userIndexes.length - this.keepRecentTurns]!;
    const prefix = snapshot.messages.slice(0, boundary);
    if (prefix.length < this.minimumPrefixMessages) return snapshot.messages;

    const summary = (await this.summarizer.summarize({
      messages: prefix,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }))
      .trim();
    if (summary === "") {
      throw new Error("Context summarizer returned an empty summary");
    }

    const summaryMessage: SystemMessage = {
      role: "system",
      content: [{
        type: "text",
        text: `Earlier conversation summary:\n\n${summary}`,
      }],
    };
    const compacted: Message[] = [
      summaryMessage,
      ...snapshot.messages.slice(boundary),
    ];
    return serializedBytes(compacted) < serializedBytes(snapshot.messages)
      ? compacted
      : snapshot.messages;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function serializedBytes(messages: readonly Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength;
}
