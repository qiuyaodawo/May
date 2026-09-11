import { createHash } from "node:crypto";
import type { Tool } from "@may/core";
import type { TaskExecutionContext, TaskSpec } from "./types.js";

/** The capability carries identity; neither sender nor command id is model-controlled. */
export function delegationTool(context: TaskExecutionContext, yielded: () => void): Tool {
  return {
    name: "delegate_tasks",
    permissionVersion: "coordination-delegation-v1",
    description: "Delegate independent child tasks to allowed agents. Use graph-unique task ids. After this complete tool step the parent yields its slot, then wakes with all child outcomes, including failures. Do not poll or resubmit the same children.",
    inputSchema: { type: "object", additionalProperties: false, required: ["tasks"], properties: {
      tasks: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["id", "agent", "input"], properties: { id: { type: "string" }, agent: { type: "string" }, input: { type: "string" } },
      } },
    } },
    parse(value: unknown): { tasks: TaskSpec[] } {
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "tasks")) throw new TypeError("Expected only a tasks array");
      const tasks = (value as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError("At least one child task is required");
      return { tasks: tasks.map((task) => {
        if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some((key) => !["id", "agent", "input"].includes(key)) ||
          [task.id, task.agent, task.input].some((value) => typeof value !== "string")) throw new TypeError("Each child needs only id, agent and input strings");
        return { id: task.id, agent: task.agent, input: task.input };
      }) };
    },
    async execute(input, call) {
      call.signal.throwIfAborted();
      if (!context.delegate) throw new Error("Delegation is not available in this host");
      const commandId = `delegate-${createHash("sha256").update(call.idempotencyKey).digest("hex")}`;
      const receipt = await context.delegate(commandId, (input as { tasks: TaskSpec[] }).tasks);
      yielded();
      return receipt;
    },
  };
}
