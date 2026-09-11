import { createHash } from "node:crypto";
import type { Tool } from "@may/core";
import type { TaskExecutionContext, TaskMessageSpec } from "./types.js";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`Expected only these fields: ${keys.join(", ") || "none"}`);
  }
  return value as Record<string, unknown>;
}

function command(kind: string, key: string): string {
  return `${kind}-${createHash("sha256").update(key).digest("hex")}`;
}

export function messagingTools(context: TaskExecutionContext, yielded: () => void): readonly Tool[] {
  return [{
    name: "send_message",
    permissionVersion: "coordination-messaging-v1",
    description: "Send text data to another existing task by id, subject to host authorization. Acceptance is durable, not proof of reading or completion. Messages do not interrupt a running task or revive a finished task. To await a reply, use wait_for_messages.",
    inputSchema: { type: "object", additionalProperties: false, required: ["toTaskId", "text"],
      properties: { toTaskId: { type: "string" }, text: { type: "string", minLength: 1 } } },
    parse(value: unknown): TaskMessageSpec {
      const input = object(value, ["toTaskId", "text"]);
      if (typeof input.toTaskId !== "string" || typeof input.text !== "string" || !input.text.length) throw new TypeError("Expected toTaskId and nonempty text strings");
      return { toTaskId: input.toTaskId, text: input.text };
    },
    async execute(input, call) {
      call.signal.throwIfAborted();
      if (!context.sendMessage) throw new Error("Messaging is not available in this host");
      return context.sendMessage(command("message", call.idempotencyKey), input as TaskMessageSpec);
    },
  }, {
    name: "wait_for_messages",
    permissionVersion: "coordination-messaging-v1",
    description: "Yield after this full tool step and wake in a new turn with unread messages. Messages already included in this turn are not unread. Does not occupy an execution slot. Cannot be combined with delegate_tasks in the same turn. If no peer sends a message, the task remains waiting; there is no automatic timeout or completion.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    parse(value: unknown) { object(value, []); return {}; },
    async execute(_input, call) {
      call.signal.throwIfAborted();
      if (!context.waitForMessages) throw new Error("Message waits are not available in this host");
      await context.waitForMessages(command("wait-messages", call.idempotencyKey));
      yielded();
      return { waiting: true };
    },
  }];
}
