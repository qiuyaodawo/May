import type { Message } from "@may/core";
import type { SessionEvent, SessionForkOrigin } from "./events.js";

export interface SessionBranchPosition {
  readonly sessionId: string;
  readonly runId: string;
  readonly positionSeq: number;
  readonly timestamp: number;
  readonly request: string;
  readonly response: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface SessionBranchNode {
  readonly sessionId: string;
  readonly fork?: SessionForkOrigin;
  readonly positions: readonly SessionBranchPosition[];
}

export interface SessionBranchCompletionOptions {
  /** 宿主已经验证调度暂停的请求成功完成，并保存全部状态。 */
  readonly allowYielded?: boolean;
}

/** 只有完整处理完成并保存状态的位置能够用于分支。 */
export function readSessionBranchPositions(history: readonly SessionEvent[]): readonly SessionBranchPosition[] {
  const positions = new Map<string, SessionBranchPosition>();
  const completedRuns = new Set<string>();
  const yieldedRuns = new Set<string>();
  let request = "";
  let response = "";
  for (const event of history) {
    if (event.type === "input.submitted") request = messageText(event.message);
    if (event.type === "run.started") response = "";
    if (event.type === "assistant.completed") response = messageText(event.message);
    if (event.type === "run.completed" || event.type === "run.yielded" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
      if (event.type === "run.completed") completedRuns.add(event.runId);
      else completedRuns.delete(event.runId);
      if (event.type === "run.yielded") yieldedRuns.add(event.runId);
      else yieldedRuns.delete(event.runId);
      const reason = event.type === "run.completed" ? "Recoverable state has not been saved" :
        event.type === "run.yielded" ? "The request is waiting for continuation" : "The request did not complete successfully";
      positions.set(event.runId, { sessionId: event.sessionId, runId: event.runId,
        positionSeq: event.seq, timestamp: event.timestamp, request, response, available: false, reason });
    }
    if (event.type === "run.settled") {
      const previous = positions.get(event.runId);
      if (previous === undefined) throw new Error(`Branch position has no completed Run: ${event.runId}`);
      if (!completedRuns.has(event.runId) && !(event.hostCompleted === true && yieldedRuns.has(event.runId))) {
        throw new Error(`Branch position requires a successful completed Run: ${event.runId}`);
      }
      positions.set(event.runId, { sessionId: previous.sessionId, runId: previous.runId,
        positionSeq: event.seq, timestamp: event.timestamp, request: previous.request, response: previous.response, available: true });
    }
  }
  const created = history[0];
  const incompleteFork = created?.type === "session.created" && created.fork !== undefined &&
    !history.some((event) => event.type === "session.fork.ready");
  return [...positions.values()].map((position) => incompleteFork ? { ...position, available: false,
    reason: "Session branch initialization has not completed" } : position);
}

export function readSessionBranchNode(history: readonly SessionEvent[]): SessionBranchNode {
  const created = history[0];
  if (created?.type !== "session.created") throw new Error("Session history has no creation event");
  return { sessionId: created.sessionId, ...(created.fork === undefined ? {} : { fork: structuredClone(created.fork) }),
    positions: readSessionBranchPositions(history) };
}

function messageText(message: Message): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}
