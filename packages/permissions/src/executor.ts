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
  PermissionEventSink,
  PermissionPolicy,
} from "./types.js";

export interface PermissionToolExecutorOptions {
  policy: PermissionPolicy;
  executor?: ToolExecutor;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve(decision: ApprovalDecision): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
}

export class PermissionToolExecutor implements ToolExecutor {
  readonly events: AsyncIterable<PermissionEvent>;

  private readonly policy: PermissionPolicy;
  private readonly executor: ToolExecutor;
  private readonly eventQueue = new AsyncEventQueue<PermissionEvent>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionGrants = new Set<string>();
  private eventSink: PermissionEventSink | undefined;
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

  setEventSink(sink: PermissionEventSink | undefined): void {
    this.eventSink = sink;
  }

  resolve(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    if (
      decision !== "allow"
      && decision !== "allow-session"
      && decision !== "deny"
    ) {
      throw new TypeError(`Invalid approval decision: ${String(decision)}`);
    }

    const pending = this.pending.get(requestId);
    if (pending === undefined) return Promise.resolve(false);
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
    return this.resolvePending(
      requestId,
      decision,
      sessionGrantKey,
      pending,
    );
  }

  revokeSessionGrant(grantKey: string): boolean {
    return this.sessionGrants.delete(grantKey);
  }

  close(reason?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    const pendingApprovals = [...this.pending.entries()];
    this.pending.clear();
    for (const [, pending] of pendingApprovals) pending.removeAbortListener();

    this.sessionGrants.clear();
    return this.closePending(pendingApprovals, reason);
  }

  private async requestApproval(
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

    let pending: PendingApproval | undefined;
    const approval = new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(request.id)) return;

        check.context.signal.removeEventListener("abort", onAbort);
        const reason = toReason(check.context.signal.reason);
        const payload: PermissionEventPayload = reason === undefined
          ? { type: "approval.cancelled", requestId: request.id }
          : { type: "approval.cancelled", requestId: request.id, reason };
        void this.emit(payload).then(
          () => reject(new RunCancelledError(reason)),
          reject,
        );
      };
      pending = {
        request,
        resolve,
        reject,
        removeAbortListener: () => {
          check.context.signal.removeEventListener("abort", onAbort);
        },
      };

      this.pending.set(request.id, pending);
      check.context.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      await this.emit({ type: "approval.requested", request });
    } catch (error) {
      if (this.pending.delete(request.id)) {
        pending?.removeAbortListener();
      }
      throw error;
    }
    return approval;
  }

  private async resolvePending(
    requestId: string,
    decision: ApprovalDecision,
    sessionGrantKey: string | undefined,
    pending: PendingApproval,
  ): Promise<boolean> {
    try {
      await this.emit({ type: "approval.resolved", requestId, decision });
    } catch (error) {
      pending.reject(error);
      throw error;
    }

    if (sessionGrantKey !== undefined) {
      this.sessionGrants.add(sessionGrantKey);
    }
    pending.resolve(decision);
    return true;
  }

  private async closePending(
    approvals: Array<[string, PendingApproval]>,
    reason: string | undefined,
  ): Promise<void> {
    let failed = false;
    let failure: unknown;

    for (const [requestId, pending] of approvals) {
      const payload: PermissionEventPayload = reason === undefined
        ? { type: "approval.cancelled", requestId }
        : { type: "approval.cancelled", requestId, reason };
      try {
        await this.emit(payload);
        pending.reject(new PermissionExecutorClosedError(reason));
      } catch (error) {
        pending.reject(error);
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }

    this.eventQueue.close();
    if (failed) throw failure;
  }

  private throwIfClosed(): void {
    if (this.closed) throw new PermissionExecutorClosedError();
  }

  private async emit(payload: PermissionEventPayload): Promise<void> {
    const event: PermissionEvent = {
      ...payload,
      seq: ++this.seq,
      timestamp: Date.now(),
    };
    await this.eventSink?.(event);
    this.eventQueue.push(event);
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
