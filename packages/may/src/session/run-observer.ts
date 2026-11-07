import { omitUndefined, type MayEvent, type ToolCall } from "../core/index.js";
import type { RecordablePermissionEvent, SessionApprovalRequest, SessionEventPayload } from "./events.js";

export function checkpointKey(event: { type: string; runId: string; step?: number; call?: ToolCall }): string {
  return JSON.stringify([event.type, event.runId, event.step, event.call?.id]);
}

export function toPermissionSessionEvent(event: RecordablePermissionEvent): SessionEventPayload {
  if (event.type === "rule.created") return { type: event.type, rule: structuredClone(event.rule) };
  if (event.type === "rule.revoked") return { type: event.type, ruleId: event.ruleId, scopeId: event.scopeId };
  if (event.type === "rule.used")
    return {
      type: event.type,
      ruleId: event.ruleId,
      scopeId: event.scopeId,
      decision: event.decision,
      runId: event.runId,
      toolCallId: event.toolCallId,
    };
  if (event.type === "approval.requested") {
    const request: SessionApprovalRequest = {
      id: event.request.id,
      createdAt: event.request.createdAt,
      tool: event.request.tool,
      input: event.request.input,
      runId: event.request.context.runId,
      step: event.request.context.step,
      toolCallId: event.request.context.toolCallId,
      idempotencyKey: event.request.context.idempotencyKey,
      ...omitUndefined({ grantKey: event.request.grantKey }),
    };
    if (event.request.persistent !== undefined) request.persistent = structuredClone(event.request.persistent);
    return { type: "approval.requested", request };
  }
  if (event.type === "approval.resolved") {
    return {
      type: "approval.resolved",
      requestId: event.requestId,
      decision: event.decision,
    };
  }
  return omitUndefined({ type: "approval.cancelled", requestId: event.requestId, reason: event.reason });
}

export function toSessionEvent(event: MayEvent): SessionEventPayload | undefined {
  switch (event.type) {
    case "input.generated":
      return {
        type: event.type,
        runId: event.runId,
        step: event.step,
        messages: [...event.messages],
        reason: event.reason,
      };
    case "run.budget.exceeded":
      return {
        type: event.type,
        runId: event.runId,
        dimension: event.dimension,
        limit: event.limit,
        consumed: event.consumed,
        budget: event.budget,
      };
    case "tool.started":
      return omitUndefined({
        type: "tool.started",
        runId: event.runId,
        step: event.step,
        call: event.call,
        input: event.input,
      });
    case "run.started":
      return event.continuation === true
        ? { type: "run.started", runId: event.runId, continuation: true }
        : { type: "run.started", runId: event.runId };
    case "model.completed":
      return omitUndefined({
        type: "assistant.completed",
        runId: event.runId,
        step: event.step,
        message: event.message,
        usage: event.usage,
        contextMessageCount: event.contextMessageCount,
      });
    case "tool.completed":
      return {
        type: "tool.completed",
        runId: event.runId,
        step: event.step,
        call: event.call,
        output: event.output,
        content: event.content,
      };
    case "tool.failed":
      return {
        type: "tool.failed",
        runId: event.runId,
        step: event.step,
        call: event.call,
        error: event.error,
      };
    case "run.completed":
      return {
        type: "run.completed",
        runId: event.runId,
        result: event.result,
      };
    case "run.yielded":
      return { type: "run.yielded", runId: event.runId, result: event.result };
    case "run.failed":
      return {
        type: "run.failed",
        runId: event.runId,
        error: event.error,
      };
    case "run.cancelled":
      return omitUndefined({ type: "run.cancelled", runId: event.runId, reason: event.reason });
    default:
      return undefined;
  }
}
