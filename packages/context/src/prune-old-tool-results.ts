import type { ContextSnapshot, Message, ToolMessage } from "@may/core";

import type { ContextCompactionStrategy } from "./compaction.js";

export interface PruneOldToolResultsOptions {
  readonly keepRecentToolResults?: number;
  readonly minimumResultBytes?: number;
}

export class PruneOldToolResultsStrategy implements ContextCompactionStrategy {
  readonly name = "prune-old-tool-results";

  private readonly keepRecentToolResults: number;
  private readonly minimumResultBytes: number;

  constructor(options: PruneOldToolResultsOptions = {}) {
    this.keepRecentToolResults = nonNegativeInteger(
      options.keepRecentToolResults ?? 4,
      "keepRecentToolResults",
    );
    this.minimumResultBytes = nonNegativeInteger(
      options.minimumResultBytes ?? 2048,
      "minimumResultBytes",
    );
  }

  compact(snapshot: Readonly<ContextSnapshot>): readonly Message[] {
    const toolIndexes = snapshot.messages
      .map((message, index) => message.role === "tool" ? index : undefined)
      .filter((index): index is number => index !== undefined);
    const retained = new Set(
      this.keepRecentToolResults === 0
        ? []
        : toolIndexes.slice(-this.keepRecentToolResults),
    );

    return snapshot.messages.map((message, index) => {
      if (message.role !== "tool" || retained.has(index)) return message;
      if (isPrunedToolMessage(message)) return message;
      const bytes = utf8Bytes(JSON.stringify(message.content));
      if (bytes < this.minimumResultBytes) return message;
      return prunedToolMessage(message, bytes);
    });
  }
}

function isPrunedToolMessage(message: ToolMessage): boolean {
  return message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text.startsWith("[Older ") &&
    / tool result pruned \(\d+ bytes\)\.\]$/u.test(message.content[0].text);
}

function prunedToolMessage(message: ToolMessage, bytes: number): ToolMessage {
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Older ${message.name} tool result pruned (${bytes} bytes).]`,
    }],
  };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
