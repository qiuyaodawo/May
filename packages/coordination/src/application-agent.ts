import type { AgentApplication, AgentDefinition } from "@may/application";
import type { Tool } from "@may/core";
import type { SessionStore } from "@may/session";
import type { CoordinationAgent, TaskExecution, TaskExecutionContext } from "./types.js";
import { coordinationInput, inspectTaskSession, taskIdentity, taskOutputFromResult, taskTurnInputId } from "./application-session.js";
import { name } from "./validation.js";
import { delegationTool } from "./delegation-tool.js";
import { messagingTools } from "./messaging-tools.js";
import { handoffTool } from "./handoff-tool.js";

export interface ApplicationAgentOptions {
  readonly version: string;
  readonly definition: AgentDefinition | ((bindings: { readonly tools: readonly Tool[]; readonly execution: TaskExecution }) => AgentDefinition);
  /** Requires a definition factory that explicitly includes the supplied tool. */
  readonly delegation?: boolean;
  /** Opt into send_message and wait_for_messages through the definition factory. */
  readonly messaging?: boolean;
  /** Opt into handoff_task through the definition factory. */
  readonly handoff?: boolean;
  /** Must remain exclusive to the matching coordination adapter while it owns a Session. */
  readonly store: SessionStore;
  /** Session 打开后、提交输入前绑定宿主的会话状态。 */
  readonly onOpen?: (application: AgentApplication, execution: TaskExecution) => void;
}

/** 每个任务 controller 一个 Session；每一轮一个确定的输入与 Run。输入不会被重放。 */
export function createApplicationAgent(options: ApplicationAgentOptions): CoordinationAgent {
  name(options.version, "agent version");
  const { version, definition, store } = options;
  const delegation = options.delegation === true;
  const messaging = options.messaging === true;
  const handoff = options.handoff === true;
  if ((delegation || messaging || handoff) && typeof definition !== "function") throw new Error("Coordination tools require a definition factory to include their scoped tools");
  const active = new Map<string, AgentApplication>();
  return {
    version,
    async execute(execution, context) {
      context.signal.throwIfAborted();
      const { sessionId } = execution.task;
      if (active.has(sessionId)) throw new Error("Task Session already active");
      const history = await store.read(sessionId);
      if (inspectTaskSession(history, execution).status !== "not-started") {
        throw new Error("Task already submitted; recover its durable outcome instead");
      }
      context.signal.throwIfAborted();
      let delegated = false;
      const yielded = () => { delegated = true; };
      const tools = [...(delegation ? [delegationTool(context, yielded)] : []), ...(messaging ? messagingTools(context, yielded) : []), ...(handoff ? [handoffTool(context, yielded)] : [])];
      const selected = typeof definition === "function" ? definition({ tools, execution }) : definition;
      const app = await selected.open({ store, sessionId, resume: history.length > 0,
        metadata: { coordination: taskIdentity(execution) },
      });
      active.set(sessionId, app);
      const relay = (async () => { for await (const event of app.events) context.report(event); })();
      // 观察 relay 失败：宿主回调抛错不能留下仍在运行的 Run。
      void relay.catch(() => app.cancel("Event relay failed"));
      try {
        options.onOpen?.(app, execution);
        context.signal.throwIfAborted();
        const run = await app.submit({ input: coordinationInput(execution), inputId: taskTurnInputId(execution), signal: context.signal,
          shouldYield: () => delegated,
          ...(execution.runBudget === undefined ? {} : { runBudget: execution.runBudget }),
          traceAttributes: { "may.coordination.id": execution.coordinationId, "may.task.id": execution.task.id, "may.dispatch.id": execution.task.dispatchId,
            "may.task.attempt": execution.task.attempt ?? 0 },
        });
        const result = await run.result;
        if (delegated && result.finishReason === "yielded") return { yielded: true };
        return taskOutputFromResult(result);
      } finally {
        try { await app.close(); await relay; }
        finally { active.delete(sessionId); }
      }
    },
    async recover(execution) {
      if (active.has(execution.task.sessionId)) return { status: "recovery-required", detail: "Task Session is still active" };
      return inspectTaskSession(await store.read(execution.task.sessionId), execution);
    },
    async resolveApproval(sessionId, requestId, decision) {
      return await active.get(sessionId)?.resolveApproval(requestId, decision) ?? false;
    },
  };
}

/** 为宿主管理的 Agent 对话提供已有的协作工具。 */
export function createCoordinationTools(context: TaskExecutionContext, onYield: () => void): readonly Tool[] {
  return [delegationTool(context, onYield), ...messagingTools(context, onYield), handoffTool(context, onYield)];
}
