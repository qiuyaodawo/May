import type { SerializedError, UserMessage } from "@sortedyuan/core";
import type { SessionEvent } from "./events.js";
import { sessionToolFailureHasUnknownEffects } from "./outcome.js";

export interface SessionTranscriptMessage {
  readonly type: "user-message";
  readonly source: "input" | "recovery" | "steering";
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly timestamp: number;
  readonly message: UserMessage;
  readonly runId?: string;
  readonly step?: number;
  readonly recoveryId?: string;
}

type MessageEvent = Extract<SessionEvent, { type:
  | "input.submitted" | "recovery.resolved" | "input.steering.queued"
  | "input.steering.delivered" | "input.steering.finished" }>;

export type SessionTranscriptEntry = SessionTranscriptMessage | {
  readonly type: "event";
  readonly event: Exclude<SessionEvent, MessageEvent>;
};

/** 顺序读取同一 Session 的记录，统一恢复结论与 steering 的消息语义。 */
export class SessionTranscriptReader {
  private readonly steering = new Map<string, UserMessage>();

  reset(): void { this.steering.clear(); }

  read(event: SessionEvent): readonly SessionTranscriptEntry[] {
    const identity = { sessionId: event.sessionId, seq: event.seq, timestamp: event.timestamp };
    switch (event.type) {
      case "input.submitted":
        if (event.inputId !== undefined) this.steering.delete(event.inputId);
        return [{ ...identity, type: "user-message", source: "input", id: `input:${event.seq}`, message: event.message }];
      case "recovery.resolved":
        return [{ ...identity, type: "user-message", source: "recovery", id: `recovery:${event.seq}`,
          recoveryId: event.recoveryId, message: event.message }];
      case "input.steering.queued":
        this.steering.set(event.input.inputId, event.input.message);
        return [];
      case "input.steering.delivered": {
        const messages = event.inputIds.map(id => {
          const message = this.steering.get(id);
          if (message === undefined) throw new Error(`Missing steering input in Session transcript: ${id}`);
          return message;
        });
        for (const id of event.inputIds) this.steering.delete(id);
        return messages.map((message, index) => ({ ...identity, type: "user-message", source: "steering",
          id: `steering:${event.runId}:${event.step}:${index}`, runId: event.runId, step: event.step, message }));
      }
      case "input.steering.finished":
        if (event.status === "cancelled") for (const id of event.inputIds) this.steering.delete(id);
        return [];
      default: return [{ type: "event", event }];
    }
  }
}

export function* readSessionTranscript(events: Iterable<SessionEvent>): Iterable<SessionTranscriptEntry> {
  const reader = new SessionTranscriptReader();
  for (const event of events) yield* reader.read(event);
}

export type SessionToolStatus = "running" | "completed" | "failed" | "denied" | "not-started" | "unknown";

/** 工具失败结果保留权限拒绝、尚未执行及效果未知的区别。 */
export function sessionToolFailureStatus(error: SerializedError, approvalCancelled = false): SessionToolStatus {
  if (error.code === "PERMISSION_DENIED") return "denied";
  if (error.code === "TOOL_SKIPPED" || error.code === "RUN_CANCELLED" && approvalCancelled) return "not-started";
  return sessionToolFailureHasUnknownEffects(error) ? "unknown" : "failed";
}
