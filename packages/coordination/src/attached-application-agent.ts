import type { AgentApplication } from "@may/application";
import type { UserMessage } from "@may/core";
import type { SessionContinueOptions, SessionEvent, SessionSubmitOptions } from "@may/session";
import {
  coordinationInput,
  inspectAttachedTaskSession,
  taskOutputFromResult,
  taskTurnInputId,
} from "./application-session.js";
import { name } from "./validation.js";
import type {
  CoordinationAgent,
  TaskExecution,
  TaskExecutionContext,
} from "./types.js";

export interface AttachedApplicationTurn {
  /** 本任务当前 Session 内的轮次，从 0 开始。 */
  readonly index: number;
  readonly first: boolean;
  /** 第一轮之后的协调唤醒输入。 */
  readonly input: string | UserMessage;
  /**
   * 在下一个完整 Step 结束处结束本轮 Run，因为宿主工具创建了必须先执行的子任务。
   * 每一轮最多调用一次。
   */
  requestYield(): void;
}

export interface AttachedApplicationAgentOptions {
  readonly version: string;
  /**
   * 宿主提供的 Session 所有者。agent 不打开也不关闭它，只使用
   * submit、continue 与 resolveApproval。
   */
  readonly attach: (execution: TaskExecution) => Pick<AgentApplication, "submit" | "continue" | "resolveApproval">;
  /** 第一轮继续已有上下文，而不是追加输入。 */
  readonly mode?: "submit" | "continue";
  /**
   * 本轮由宿主决定的 submit 选项。input、inputId、让出边界与任务取消信号
   * 始终由本 agent 提供。
   */
  readonly submit: (
    execution: TaskExecution,
    turn: AttachedApplicationTurn,
    context: TaskExecutionContext,
  ) => SessionSubmitOptions;
  /** Read-only durable history access used by recovery inspection. */
  readonly read: (sessionId: string) => Promise<readonly SessionEvent[]>;
  /**
   * 本轮输入的持久身份。宿主可以为第一轮提供自己的身份（例如 steering 输入的
   * inputId），之后的轮次使用协调生成的 dispatch 身份。
   */
  readonly identity?: (execution: TaskExecution, turn: AttachedApplicationTurn) => string;
}

/** 宿主已经持有 Session 的任务使用的 coordination agent。 */
export function createAttachedApplicationAgent(
  options: AttachedApplicationAgentOptions,
): CoordinationAgent {
  name(options.version, "agent version");
  // 宿主 Session 可能已经保存了更早请求的输入，按输入身份定位本轮。
  const inspect = (execution: TaskExecution) => {
    const inputId = options.identity?.(execution, turnOf(execution));
    return {
      mode: options.mode ?? "submit" as const,
      ...(inputId === undefined ? {} : { inputId }),
    };
  };
  const turnOf = (execution: TaskExecution): AttachedApplicationTurn => ({
    index: execution.task.turn ?? 0,
    first: (execution.task.turn ?? 0) === (execution.task.sessionStartTurn ?? 0),
    input: "",
    requestYield: () => undefined,
  });
  const identityOf = (execution: TaskExecution, turn: AttachedApplicationTurn): string =>
    options.identity?.(execution, turn) ?? taskTurnInputId(execution);
  const applications = new Map<string, Pick<AgentApplication, "submit" | "continue" | "resolveApproval">>();
  return {
    version: options.version,
    async execute(execution, context) {
      context.signal.throwIfAborted();
      const { sessionId } = execution.task;
      if (applications.has(sessionId)) throw new Error("Task Session already active");
      if (inspectAttachedTaskSession(
        await options.read(sessionId),
        execution,
        inspect(execution),
      ).status !== "not-started") {
        throw new Error("Task already submitted; recover its durable outcome instead");
      }
      context.signal.throwIfAborted();
      let delegated = false;
      const turn: AttachedApplicationTurn = {
        index: execution.task.turn ?? 0,
        first: (execution.task.turn ?? 0) === (execution.task.sessionStartTurn ?? 0),
        input: coordinationInput(execution),
        requestYield: () => { delegated = true; },
      };
      const inputId = identityOf(execution, turn);
      const declared = options.submit(execution, turn, context);
      const application = options.attach(execution);
      applications.set(sessionId, application);
      const { input: _input, inputId: _inputId, ...rest } = declared;
      const signal = declared.signal === undefined
        ? context.signal
        : AbortSignal.any([declared.signal, context.signal]);
      try {
        // 宿主的让出边界与委派让出共用同一个 Run 边界。
        const shouldYield = () => delegated || declared.shouldYield?.() === true;
        const run = turn.first && (options.mode ?? "submit") === "continue"
          ? await application.continue({ ...rest, shouldYield, signal } as SessionContinueOptions)
          : await application.submit({
              ...rest,
              input: turn.first ? (declared.input as string | UserMessage) : turn.input,
              inputId,
              shouldYield,
              signal,
            });
        const result = await run.result;
        if (delegated && result.finishReason === "yielded") return { yielded: true };
        return taskOutputFromResult(result);
      } finally {
        applications.delete(sessionId);
      }
    },
    async recover(execution) {
      if (applications.has(execution.task.sessionId)) return { status: "recovery-required", detail: "Task Session is still active" };
      return inspectAttachedTaskSession(
        await options.read(execution.task.sessionId),
        execution,
        inspect(execution),
      );
    },
    async resolveApproval(sessionId, requestId, decision) {
      const application = applications.get(sessionId);
      if (application === undefined) return false;
      return await application.resolveApproval(requestId, decision) ?? false;
    },
  };
}
