import { createHash } from "node:crypto";
import type { Tool } from "@may/core";
import type { HandoffSpec, TaskExecutionContext } from "./types.js";

export function handoffTool(context: TaskExecutionContext, yielded: () => void): Tool {
  return {
    name: "handoff_task",
    permissionVersion: "coordination-handoff-v1",
    description: "Transfer this logical task to another allowed agent with an explicit context summary. After this complete tool step safely yields, the target starts in a fresh Session and supplies the task's final result; this controller does not automatically resume. Do not combine with delegation or message waits. Receive pending mail first. History, approvals and tools are not transferred.",
    inputSchema: { type: "object", additionalProperties: false, required: ["agent", "input"],
      properties: { agent: { type: "string" }, input: { type: "string", minLength: 1 } } },
    parse(value: unknown): HandoffSpec {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["agent", "input"].includes(key))) throw new TypeError("Expected only agent and input");
      const spec = value as Record<string, unknown>;
      if (typeof spec.agent !== "string" || typeof spec.input !== "string" || !spec.input.length) throw new TypeError("Handoff requires agent and nonempty input strings");
      return { agent: spec.agent, input: spec.input };
    },
    async execute(input, call) {
      call.signal.throwIfAborted();
      if (!context.handoff) throw new Error("Handoff is not available in this host");
      const commandId = `handoff-${createHash("sha256").update(call.idempotencyKey).digest("hex")}`;
      const receipt = await context.handoff(commandId, input as HandoffSpec);
      yielded();
      return receipt;
    },
  };
}
