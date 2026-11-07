import {
  DEFAULT_RUNTIME_DESCRIPTOR,
  omitUndefined,
  toolCancellationMessage,
  validateRuntimeDescriptor,
  type Message,
  type RuntimeDescriptor,
  type ToolCall,
  type UserMessage,
} from "../core/index.js";
import { sessionToolResultContent, type SessionEvent } from "./events.js";
import type { SessionModelMeasurement, SessionRuntimeInfo } from "./session.js";

export function modelStepKey(runId: string, step: number): string {
  return `${runId}:${step}`;
}

export function replaySession(events: readonly SessionEvent[]): {
  messages: Message[];
  info: SessionRuntimeInfo;
} {
  const messages: Message[] = [];
  const steeringInputs = new Map<string, UserMessage>();
  const pendingTools = new Map<string, Map<string, ToolCall>>();
  const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let latestModelMeasurement: SessionModelMeasurement | undefined;
  let runtime: RuntimeDescriptor | undefined;
  let runtimeState: unknown;

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        runtime = event.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR;
        break;
      case "runtime.changed":
        validateRuntimeDescriptor(event.runtime);
        runtime = event.runtime;
        runtimeState = structuredClone(event.state);
        break;
      case "runtime.state.saved":
        if (runtime === undefined) throw new Error("Runtime state requires Session creation metadata");
        validateRuntimeDescriptor(event.runtime);
        if (
          runtime.id !== event.runtime.id ||
          runtime.version !== event.runtime.version ||
          runtime.stateVersion !== event.runtime.stateVersion
        )
          throw new Error("Saved runtime state has an incompatible descriptor");
        runtimeState = structuredClone(event.state);
        break;
      case "input.generated":
        messages.push(...event.messages);
        break;
      case "state.updated":
        state[event.key] = event.value;
        break;
      case "run.interrupted":
        for (const recovery of event.recoveries) {
          const error =
            recovery.status === "not-started"
              ? {
                  code: "TOOL_NOT_EXECUTED",
                  message: "The process stopped before this tool's execution checkpoint. The tool was not executed.",
                }
              : {
                  code: "TOOL_OUTCOME_UNKNOWN",
                  message:
                    "The process stopped without a durable outcome. External effects may have occurred. Do not repeat this operation without verified recovery findings.",
                };
          messages.push({
            role: "tool",
            name: recovery.call.name,
            toolCallId: recovery.call.id,
            isError: true,
            content: [{ type: "json", value: error }],
          });
        }
        break;
      case "recovery.resolved":
        messages.push(event.message);
        break;
      case "input.submitted":
        messages.push(event.message);
        break;
      case "input.steering.queued":
        steeringInputs.set(event.input.inputId, event.input.message);
        break;
      case "input.steering.delivered":
        for (const inputId of event.inputIds) {
          const input = steeringInputs.get(inputId);
          if (input === undefined) throw new Error(`Missing steering input: ${inputId}`);
          messages.push(input);
        }
        break;
      case "assistant.completed":
        messages.push(event.message);
        if (event.message.toolCalls !== undefined && event.message.toolCalls.length > 0) {
          pendingTools.set(
            modelStepKey(event.runId, event.step),
            new Map(event.message.toolCalls.map((call) => [call.id, call])),
          );
        }
        if (event.usage?.inputTokens !== undefined && event.contextMessageCount !== undefined) {
          latestModelMeasurement = {
            inputTokens: event.usage.inputTokens,
            contextMessageCount: event.contextMessageCount,
          };
        }
        break;
      case "context.compacted":
        messages.splice(0, messages.length, ...event.messages);
        pendingTools.clear();
        latestModelMeasurement = undefined;
        break;
      case "tool.completed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: sessionToolResultContent(event),
        });
        resolvePendingTool(pendingTools, event.runId, event.step, event.call.id);
        break;
      case "tool.failed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: [{ type: "json", value: event.error }],
          isError: true,
        });
        resolvePendingTool(pendingTools, event.runId, event.step, event.call.id);
        break;
      case "run.cancelled":
        for (const [key, calls] of pendingTools) {
          if (!key.startsWith(`${event.runId}:`)) continue;
          messages.push(...[...calls.values()].map((call) => toolCancellationMessage(call, event.reason)));
          pendingTools.delete(key);
        }
        break;
      case "approval.cancelled":
      case "approval.requested":
      case "approval.resolved":
      case "continuation.submitted":
      case "history.omitted":
      case "input.steering.finished":
      case "model.attempt.completed":
      case "model.attempt.failed":
      case "model.attempt.started":
      case "model.request.defined":
      case "model.request.prepared":
      case "rule.created":
      case "rule.revoked":
      case "rule.used":
      case "run.budget.exceeded":
      case "run.completed":
      case "run.failed":
      case "run.settled":
      case "run.started":
      case "run.yielded":
      case "session.fork.ready":
      case "tool.presentation":
      case "tool.started":
        break;
    }
  }

  // Outcomes are durable in completion order, but model messages follow call order.
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const order = new Map(message.toolCalls.map((call, position) => [call.id, position]));
    let end = index + 1;
    while (messages[end]?.role === "tool") end++;
    const results = messages.slice(index + 1, end);
    results.sort(
      (a, b) =>
        (a.role === "tool" ? (order.get(a.toolCallId) ?? Infinity) : Infinity) -
        (b.role === "tool" ? (order.get(b.toolCallId) ?? Infinity) : Infinity),
    );
    messages.splice(index + 1, results.length, ...results);
  }
  return {
    messages,
    info: omitUndefined({
      latestModelMeasurement,
      runtime,
      runtimeState,
      state: Object.keys(state).length === 0 ? undefined : state,
    }),
  };
}

function resolvePendingTool(
  pending: Map<string, Map<string, ToolCall>>,
  runId: string,
  step: number,
  toolCallId: string,
): void {
  const key = modelStepKey(runId, step);
  const calls = pending.get(key);
  if (calls === undefined) return;
  calls.delete(toolCallId);
  if (calls.size === 0) pending.delete(key);
}
