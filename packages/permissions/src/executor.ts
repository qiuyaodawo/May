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
  request: ApprovalRequest;
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
  private readonly sessionGrants = new Set<string>();
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
    const outcome = normalizeDecision(await this.policy(check));

    this.throwIfClosed();
    throwIfAborted(execution.context.signal);

    if (outcome.decision === "deny") {
      throw new PermissionDeniedError(execution.tool.name);
    }
    if (outcome.decision === "ask") {
      const granted = outcome.grantKey !== undefined
        && this.sessionGrants.has(outcome.grantKey);
      if (!granted) {
        const approval = await this.requestApproval(check, outcome.grantKey);
        if (approval === "deny") {
          throw new PermissionDeniedError(execution.tool.name);
        }
      }
    }

    this.throwIfClosed();
    throwIfAborted(execution.context.signal);
    return this.executor.execute(execution);
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    if (
      decision !== "allow"
      && decision !== "allow-session"
      && decision !== "deny"
    ) {
      throw new TypeError(`Invalid approval decision: ${String(decision)}`);
    }

    const pending = this.pending.get(requestId);
    if (pending === undefined) return false;
    const sessionGrantKey = decision === "allow-session"
      ? pending.request.grantKey
      : undefined;
    if (decision === "allow-session" && sessionGrantKey === undefined) {
      throw new TypeError(
        `Approval request "${requestId}" does not define a session grant key`,
      );
    }

    this.pending.delete(requestId);
    pending.removeAbortListener();
    if (sessionGrantKey !== undefined) {
      this.sessionGrants.add(sessionGrantKey);
    }
    this.emit({ type: "approval.resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  }

  revokeSessionGrant(grantKey: string): boolean {
    return this.sessionGrants.delete(grantKey);
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

    this.sessionGrants.clear();
    this.eventQueue.close();
  }

  private requestApproval(
    check: PermissionCheck,
    grantKey: string | undefined,
  ): Promise<ApprovalDecision> {
    const request: ApprovalRequest = grantKey === undefined
      ? {
          ...check,
          id: createApprovalId(),
          createdAt: Date.now(),
        }
      : {
          ...check,
          id: createApprovalId(),
          createdAt: Date.now(),
          grantKey,
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
        request,
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

interface NormalizedDecision {
  decision: "allow" | "deny" | "ask";
  grantKey?: string;
}

function normalizeDecision(value: PermissionDecision): NormalizedDecision {
  if (value === "allow" || value === "deny" || value === "ask") {
    return { decision: value };
  }
  if (
    typeof value === "object"
    && value !== null
    && value.decision === "ask"
  ) {
    if (typeof value.grantKey !== "string" || value.grantKey.trim() === "") {
      throw new TypeError("Invalid session grant key");
    }
    return { decision: "ask", grantKey: value.grantKey };
  }
  throw new TypeError(`Invalid permission decision: ${String(value)}`);
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
