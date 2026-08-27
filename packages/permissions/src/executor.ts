import {
  AsyncEventQueue,
  directToolExecutor,
  RunCancelledError,
  type ToolExecution,
  type ToolExecutor,
} from "@may/core";

import {
  PermissionDeniedError,
  PermissionExecutorClosedError,
} from "./errors.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  PermissionCheck,
  PermissionDecision,
  PermissionEvent,
  PermissionEventPayload,
  PermissionPolicy,
} from "./types.js";

export interface PermissionToolExecutorOptions {
  policy: PermissionPolicy;
  executor?: ToolExecutor;
}

interface PendingApproval {
  resolve(decision: ApprovalDecision): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export class PermissionToolExecutor implements ToolExecutor {
  readonly events: AsyncIterable<PermissionEvent>;

  private readonly policy: PermissionPolicy;
  private readonly executor: ToolExecutor;
  private readonly eventQueue = new AsyncEventQueue<PermissionEvent>();
  private readonly pending = new Map<string, PendingApproval>();
  private closed = false;
  private seq = 0;

  constructor(options: PermissionToolExecutorOptions) {
    this.policy = options.policy;
    this.executor = options.executor ?? directToolExecutor;
    this.events = this.eventQueue;
  }

  async execute<TInput, TOutput>(
    execution: ToolExecution<TInput, TOutput>,
  ): Promise<TOutput> {
    this.throwIfClosed();
    throwIfAborted(execution.context.signal);

    const check: PermissionCheck = {
      tool: {
        name: execution.tool.name,
        description: execution.tool.description,
        inputSchema: execution.tool.inputSchema,
      },
      input: execution.input,
      context: execution.context,
    };
    const decision = await this.policy(check);

    this.throwIfClosed();
    throwIfAborted(execution.context.signal);

    if (decision === "deny") {
      throw new PermissionDeniedError(execution.tool.name);
    }
    if (decision === "ask") {
      const approval = await this.requestApproval(check);
      if (approval === "deny") {
        throw new PermissionDeniedError(execution.tool.name);
      }
    } else if (decision !== "allow") {
      throw new TypeError(`Invalid permission decision: ${String(decision)}`);
    }

    this.throwIfClosed();
    throwIfAborted(execution.context.signal);
    return this.executor.execute(execution);
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    if (decision !== "allow" && decision !== "deny") {
      throw new TypeError(`Invalid approval decision: ${String(decision)}`);
    }

    const pending = this.pending.get(requestId);
    if (pending === undefined) return false;

    this.pending.delete(requestId);
    pending.removeAbortListener();
    this.emit({ type: "approval.resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.removeAbortListener();
      this.emit(reason === undefined
        ? { type: "approval.cancelled", requestId }
        : { type: "approval.cancelled", requestId, reason });
      pending.reject(new PermissionExecutorClosedError(reason));
    }

    this.eventQueue.close();
  }

  private requestApproval(check: PermissionCheck): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...check,
      id: createApprovalId(),
      createdAt: Date.now(),
    };

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(request.id)) return;

        check.context.signal.removeEventListener("abort", onAbort);
        const reason = toReason(check.context.signal.reason);
        this.emit(reason === undefined
          ? { type: "approval.cancelled", requestId: request.id }
          : { type: "approval.cancelled", requestId: request.id, reason });
        reject(new RunCancelledError(reason));
      };
      const pending: PendingApproval = {
        resolve,
        reject,
        removeAbortListener: () => {
          check.context.signal.removeEventListener("abort", onAbort);
        },
      };

      this.pending.set(request.id, pending);
      check.context.signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "approval.requested", request });
    });
  }

  private throwIfClosed(): void {
    if (this.closed) throw new PermissionExecutorClosedError();
  }

  private emit(payload: PermissionEventPayload): void {
    this.eventQueue.push({
      ...payload,
      seq: ++this.seq,
      timestamp: Date.now(),
    });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelledError(toReason(signal.reason));
}

function toReason(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return undefined;
}

function createApprovalId(): string {
  return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
