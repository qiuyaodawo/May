import type { CoordinationSnapshot } from "@sortedyuan/coordination";
import type { ContentPart } from "@sortedyuan/may/core";
import type { GatewayStore } from "../gateway-store.js";
import type { GatewayActor, GatewayMessage, GatewaySession, GatewayTask } from "../gateway-types.js";

export interface GraphRecord {
  id: string;
  sessionId: string;
  actor: GatewayActor;
  messageId: string;
  content?: ContentPart[];
  rootInputId?: string;
}

export function projectTask(
  store: GatewayStore,
  graph: GraphRecord,
  source: CoordinationSnapshot["tasks"][number],
): GatewayTask {
  const id = `${graph.id}:${source.id}`,
    prior = store.get<GatewayTask>("tasks", id);
  const session = store.get<GatewaySession>("sessions", graph.sessionId);
  if (!session) throw new Error(`任务所属会话 ${graph.sessionId} 不存在。`);
  const inputId =
    graph.rootInputId && !source.parentTaskId && (source.turn ?? 0) === 0
      ? graph.rootInputId
      : `${source.dispatchId}:${source.turn ?? 0}`;
  return {
    ...prior,
    id,
    sessionId: graph.sessionId,
    agentId: source.agent,
    graphId: graph.id,
    graphTaskId: source.id,
    actor: graph.actor,
    input: source.input,
    inputId,
    status: source.status,
    createdAt:
      prior?.createdAt ?? store.get<GatewayMessage>("messages", graph.messageId)?.createdAt ?? session.createdAt,
    updatedAt: prior?.updatedAt ?? Date.now(),
  };
}

export function completeTask(
  store: GatewayStore,
  task: GatewayTask,
  result: { text: string; runId?: string; content?: ContentPart[] },
  record: (
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
  ) => GatewayMessage,
): GatewayTask {
  return store.transaction(() => {
    const session = store.get<GatewaySession>("sessions", task.sessionId);
    if (!session) throw new Error(`任务所属会话 ${task.sessionId} 不存在。`);
    const { detail: _detail, ...current } = { ...store.get<GatewayTask>("tasks", task.id), ...task };
    const completed: GatewayTask = {
      ...current,
      status: "completed",
      result: result.text,
      ...(result.runId ? { runId: result.runId } : {}),
      updatedAt: Date.now(),
    };
    store.put("tasks", task.id, completed);
    if (
      !store
        .list<GatewayMessage>("messages")
        .some((message) => message.taskId === task.id && message.kind === "assistant")
    ) {
      record(session, {
        kind: "assistant",
        text: result.text,
        agentId: task.agentId,
        taskId: task.id,
        ...(result.content ? { content: result.content } : {}),
      });
    }
    return completed;
  });
}
