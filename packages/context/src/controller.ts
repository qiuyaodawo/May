import type { Context, ContextSnapshot, Message } from "@may/core";

export interface ContextInspection {
  readonly instructionsBytes: number;
  readonly messageBytes: number;
  readonly totalBytes: number;
  readonly messageCount: number;
  readonly messagesByRole: Readonly<Record<Message["role"], number>>;
  readonly toolResultCount: number;
  readonly estimatedTokens: number;
  readonly tokenEstimateMethod: "utf8-bytes/4";
}

export interface ContextController {
  inspect(): Promise<ContextInspection>;
}

export class SnapshotContextController implements ContextController {
  constructor(private readonly context: Context) {}

  async inspect(): Promise<ContextInspection> {
    return inspectContextSnapshot(await this.context.snapshot());
  }
}

export function inspectContextSnapshot(
  snapshot: ContextSnapshot,
): ContextInspection {
  const messagesByRole: Record<Message["role"], number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  let messageBytes = 0;

  for (const message of snapshot.messages) {
    messagesByRole[message.role] += 1;
    messageBytes += utf8Bytes(JSON.stringify(message));
  }

  const instructionsBytes = utf8Bytes(snapshot.instructions ?? "");
  const totalBytes = instructionsBytes + messageBytes;
  return {
    instructionsBytes,
    messageBytes,
    totalBytes,
    messageCount: snapshot.messages.length,
    messagesByRole,
    toolResultCount: messagesByRole.tool,
    estimatedTokens: Math.ceil(totalBytes / 4),
    tokenEstimateMethod: "utf8-bytes/4",
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
