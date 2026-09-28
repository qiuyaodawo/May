import { createHash } from "node:crypto";
import type { Tool } from "@may/core";
import type { TaskExecutionContext, TaskSpec } from "./types.js";
import { validateTaskFiles } from "./validation.js";

export interface DelegationToolOptions {
  /** 宿主当前授权的角色；模型在描述中可以直接看到它们。 */
  readonly agents?: readonly string[];
  /** 描述本次部署的文件与工具语义的宿主规则。 */
  readonly guidance?: string;
  /** 单个子任务说明的最大字节数，与宿主输入限制一致。 */
  readonly maxInputBytes?: number;
}

const MAX_CHILDREN = 8;

/** 能力对象携带身份；发送方和命令 id 都不接受模型输入。 */
export function delegationTool(
  context: TaskExecutionContext,
  yielded: () => void,
  options: DelegationToolOptions = {},
): Tool {
  const agents = options.agents ?? [];
  return {
    name: "delegate_tasks",
    permissionVersion: "coordination-delegation-v1",
    description: [
      "Delegate independent child tasks to allowed agents, then continue after their outcomes arrive.",
      "Use graph-unique task ids, one agent per task, and give every child a complete standalone brief: the goal, the exact files it owns, the constraints, and the report format.",
      "After this complete tool step the parent yields its slot, children run, and the parent wakes with all child outcomes, including failures.",
      "Do not poll, do not resubmit the same children, and never ask a child for a decision only the user can make.",
      ...(agents.length === 0 ? [] : [`Currently authorized roles: ${agents.join(", ")}.`]),
      ...(options.guidance === undefined ? [] : [options.guidance]),
    ].join(" "),
    inputSchema: { type: "object", additionalProperties: false, required: ["tasks"], properties: {
      tasks: { type: "array", minItems: 1, maxItems: MAX_CHILDREN, items: { type: "object", additionalProperties: false,
        required: ["id", "agent", "input"], properties: {
          id: { type: "string", description: "Graph-unique task id" },
          agent: { type: "string", description: "One authorized role" },
          input: { type: "string", description: "Complete standalone brief for this child" },
          files: { type: "array", maxItems: 128, items: { type: "string" },
            description: "Workspace-relative files this child may modify" },
        },
      } },
    } },
    parse(value: unknown): { tasks: TaskSpec[] } {
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "tasks")) throw new TypeError("Expected only a tasks array");
      const tasks = (value as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_CHILDREN) throw new TypeError(`Between 1 and ${MAX_CHILDREN} child tasks are required`);
      return { tasks: tasks.map((task) => {
        if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some((key) => !["id", "agent", "input", "files"].includes(key)) ||
          [task.id, task.agent, task.input].some((value) => typeof value !== "string")) throw new TypeError("Each child needs only id, agent and input strings, plus optional files");
        if (Buffer.byteLength(task.input, "utf8") > (options.maxInputBytes ?? 65_536)) throw new RangeError(`Each child brief is limited to ${options.maxInputBytes ?? 65_536} bytes`);
        if (task.files !== undefined) validateTaskFiles(task.files as string[]);
        return { id: task.id, agent: task.agent, input: task.input,
          ...(task.files === undefined ? {} : { files: [...(task.files as string[])] }) };
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
