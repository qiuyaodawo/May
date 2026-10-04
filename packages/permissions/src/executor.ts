import {
  AsyncEventQueue,
  directToolExecutor,
  endTraceSpan,
  FatalToolExecutionError,
  freezeToolInput,
  RunCancelledError,
  startTraceSpan,
  traceError,
  type ToolExecution,
  type ToolExecutor,
  type TraceSpan,
  type Tracer,
} from "@may/core";

import {
  PermissionDeniedError,
  PermissionExecutorClosedError,
} from "./errors.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolveOptions,
  CreatePermissionRuleOptions,
  PermissionCheck,
  PermissionDecision,
  PermissionEvent,
  PermissionEventPayload,
  PermissionEventSink,
  PermissionPolicy,
} from "./types.js";
import type { PermissionRuleStore, PersistentPermissionRule } from "./rules.js";

export interface PermissionToolExecutorOptions {
  policy: PermissionPolicy;
  beforeCheck?: (check: PermissionCheck) => void | Promise<void>;
  executor?: ToolExecutor;
  ruleStore?: PermissionRuleStore;
  /** 与 Agent runtime 共享的可选 tracer。 */
  tracer?: Tracer;
}

interface PendingApproval {
  request: ApprovalRequest;
  definitionKey: string;
  outcome: NormalizedDecision;
  resolving: boolean;
  resolve(result: ApprovalResolution): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
}

export class PermissionToolExecutor implements ToolExecutor {
  readonly events: AsyncIterable<PermissionEvent>;

  private readonly policy: PermissionPolicy;
  private readonly beforeCheck: PermissionToolExecutorOptions["beforeCheck"];
  private readonly executor: ToolExecutor;
  private readonly tracer: Tracer | undefined;
  private readonly ruleStore: PermissionRuleStore | undefined;
  private readonly eventQueue = new AsyncEventQueue<PermissionEvent>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionGrants = new Map<string, Set<string>>();
  private eventSink: PermissionEventSink | undefined;
  private closed = false;
  private seq = 0;

  constructor(options: PermissionToolExecutorOptions) {
    this.policy = options.policy;
    this.beforeCheck = options.beforeCheck;
    this.executor = options.executor ?? directToolExecutor;
    this.tracer = options.tracer;
    this.ruleStore = options.ruleStore;
    this.events = this.eventQueue;
  }

  async execute<TInput, TOutput>(
    execution: ToolExecution<TInput, TOutput>,
  ): Promise<TOutput> {
    try {
      this.throwIfClosed();
      throwIfAborted(execution.context.signal);
      execution = Object.freeze({ ...execution, input: freezeToolInput(execution.input) });

      const check = immutableCheck(execution);
      const definitionKey = permissionDefinitionKey(check.tool);
      await this.beforeCheck?.(check);
      this.checkExecution(check);
      const outcome = await this.evaluatePolicy(check);

      this.throwIfClosed();
      throwIfAborted(execution.context.signal);

      if (outcome.decision === "deny") throw new PermissionDeniedError(check.tool.name);
      const rules = await this.matchingRules(check, outcome, definitionKey);
      this.checkExecution(check);
      await this.rejectDenied(check, outcome, rules);
      if (outcome.decision === "ask") {
        const allowedRule = outcome.requireApproval ? undefined : rules.find((rule) => rule.decision === "allow");
        const granted = !outcome.requireApproval && outcome.grantKey !== undefined
          && this.sessionGrants.get(outcome.grantKey)?.has(sessionDefinitionKey(outcome, definitionKey)) === true;
        if (allowedRule !== undefined) {
          await this.useRule(allowedRule, check);
          await this.recheckRule(check, outcome, definitionKey, allowedRule.id);
        } else if (!granted) {
          const approval = await this.waitForApproval(check, outcome, definitionKey);
          if (approval.decision === "deny") {
            throw new PermissionDeniedError(execution.tool.name);
          }
          await this.recheckApproval(check, outcome, definitionKey, approval);
        }
      }

      this.throwIfClosed();
      throwIfAborted(execution.context.signal);
      if (permissionDefinitionKey(execution.tool) !== definitionKey) {
        throw new PermissionDeniedError(check.tool.name);
      }
    } catch (error) {
      if (
        error instanceof PermissionDeniedError ||
        error instanceof RunCancelledError ||
        error instanceof FatalToolExecutionError
      ) {
        throw error;
      }
      throw fatalPermissionError(execution.tool.name, error);
    }

    return this.executor.execute(execution);
  }

  private async evaluatePolicy(check: PermissionCheck): Promise<NormalizedDecision> {
    const span = startTraceSpan(this.tracer, "may.permission.check", {
      ...(check.context.traceContext === undefined
        ? {}
        : { parent: check.context.traceContext }),
      attributes: {
        "may.step": check.context.step,
        "may.tool.name": check.tool.name,
        "may.tool.call_id": check.context.toolCallId,
      },
    });
    try {
      const outcome = normalizeDecision(await this.policy(check));
      endTraceSpan(span, {
        status: "ok",
        attributes: { "may.permission.decision": outcome.decision },
      });
      return outcome;
    } catch (error) {
      endPermissionSpan(span, error, check.context.signal);
      throw error;
    }
  }

  private async waitForApproval(
    check: PermissionCheck,
    outcome: NormalizedDecision,
    definitionKey: string,
  ): Promise<ApprovalResolution> {
    const span = startTraceSpan(this.tracer, "may.permission.approval_wait", {
      ...(check.context.traceContext === undefined
        ? {}
        : { parent: check.context.traceContext }),
      attributes: {
        "may.step": check.context.step,
        "may.tool.name": check.tool.name,
        "may.tool.call_id": check.context.toolCallId,
      },
    });
    try {
      const result = await this.requestApproval(check, outcome, definitionKey);
      endTraceSpan(span, {
        status: "ok",
        attributes: { "may.permission.approval": result.decision },
      });
      return result;
    } catch (error) {
      endPermissionSpan(span, error, check.context.signal);
      throw error;
    }
  }

  setEventSink(sink: PermissionEventSink | undefined): void {
    this.eventSink = sink;
  }

  async resolve(
    requestId: string,
    decision: ApprovalDecision,
    options?: ApprovalResolveOptions,
  ): Promise<boolean> {
    if (
      decision !== "allow"
      && decision !== "allow-session"
      && decision !== "allow-persistent"
      && decision !== "deny"
    ) {
      throw new TypeError(`Invalid approval decision: ${String(decision)}`);
    }

    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.resolving) return false;
    const sessionGrantKey = decision === "allow-session"
      ? pending.request.grantKey
      : undefined;
    if (decision === "allow-session" && sessionGrantKey === undefined) {
      throw new TypeError(
        `Approval request "${requestId}" does not define a session grant key`,
      );
    }
    if (decision === "allow-persistent") {
      if (pending.request.persistent === undefined) {
        throw new TypeError(`Approval request "${requestId}" does not allow persistent rules`);
      }
      validateRuleOptions(options);
      options = Object.freeze({
        createdBy: options!.createdBy,
        ...(options!.expiresAt === undefined ? {} : { expiresAt: options!.expiresAt }),
      });
    }

    pending.resolving = true;
    return this.resolvePending(
      requestId,
      decision,
      sessionGrantKey,
      pending,
      options,
    );
  }

  async createRule(
    check: PermissionCheck,
    options: CreatePermissionRuleOptions,
  ): Promise<PersistentPermissionRule> {
    this.checkExecution(check);
    validateRuleOptions(options);
    if (options.decision !== "allow" && options.decision !== "deny") {
      throw new TypeError("Invalid persistent rule decision");
    }
    options = Object.freeze({
      decision: options.decision,
      createdBy: options.createdBy,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    const store = this.requireRuleStore();
    const immutable = immutableCheck(check);
    const outcome = await this.evaluatePolicy(immutable);
    this.checkExecution(immutable);
    if (outcome.persistent === undefined || outcome.grantKey === undefined) {
      throw new TypeError("Permission policy does not define a persistent scope");
    }
    if (options.decision === "allow" && (outcome.decision === "deny" || outcome.requireApproval)) {
      throw new TypeError("Permission policy does not allow a persistent grant for this operation");
    }
    const rule = makeRule(immutable, outcome, permissionDefinitionKey(immutable.tool), options);
    await store.create(rule);
    this.checkExecution(immutable);
    await this.emit({ type: "rule.created", rule });
    this.checkExecution(immutable);
    return rule;
  }

  async listRules(scopeId?: string): Promise<readonly PersistentPermissionRule[]> {
    this.throwIfClosed();
    return this.requireRuleStore().list(scopeId);
  }

  async createRuleFrom(
    sourceId: string,
    options: CreatePermissionRuleOptions,
  ): Promise<PersistentPermissionRule> {
    this.throwIfClosed();
    validateRuleOptions(options);
    if (options.decision !== "allow" && options.decision !== "deny") {
      throw new TypeError("Invalid persistent rule decision");
    }
    options = Object.freeze({
      decision: options.decision,
      createdBy: options.createdBy,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    const store = this.requireRuleStore();
    const source = (await store.list()).find((rule) => rule.id === sourceId);
    this.throwIfClosed();
    if (source === undefined) throw new TypeError(`Persistent permission rule does not exist: ${sourceId}`);
    validateRuleOptions(options);
    const rule = Object.freeze({
      id: `permission_rule_${crypto.randomUUID()}`,
      scopeId: source.scopeId,
      toolName: source.toolName,
      definitionKey: source.definitionKey,
      grantKey: source.grantKey,
      description: source.description,
      decision: options.decision,
      createdAt: Date.now(),
      createdBy: options.createdBy,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    await store.create(rule);
    this.throwIfClosed();
    await this.emit({ type: "rule.created", rule });
    this.throwIfClosed();
    return rule;
  }

  async revokeRule(ruleId: string): Promise<boolean> {
    this.throwIfClosed();
    const store = this.requireRuleStore();
    const rule = (await store.list()).find((candidate) => candidate.id === ruleId);
    this.throwIfClosed();
    if (rule === undefined || !await store.revoke(ruleId)) return false;
    await this.emit({ type: "rule.revoked", ruleId, scopeId: rule.scopeId });
    return true;
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
    outcome: NormalizedDecision,
    definitionKey: string,
  ): Promise<ApprovalResolution> {
    const request: ApprovalRequest = Object.freeze({
      ...check,
      id: createApprovalId(),
      createdAt: Date.now(),
      ...(outcome.grantKey === undefined || outcome.requireApproval ? {} : { grantKey: outcome.grantKey }),
      ...(this.ruleStore === undefined || outcome.persistent === undefined || outcome.requireApproval ? {} : {
        persistent: Object.freeze({ ...outcome.persistent, definitionKey }),
      }),
    });

    let pending: PendingApproval | undefined;
    const approval = new Promise<ApprovalResolution>((resolve, reject) => {
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
        definitionKey,
        outcome,
        resolving: false,
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
      const [, result] = await Promise.all([
        this.emit({ type: "approval.requested", request }),
        approval,
      ]);
      return result;
    } catch (error) {
      if (this.pending.delete(request.id)) {
        pending?.removeAbortListener();
        pending?.reject(error);
      }
      throw error;
    }
  }

  private async resolvePending(
    requestId: string,
    decision: ApprovalDecision,
    sessionGrantKey: string | undefined,
    pending: PendingApproval,
    options: ApprovalResolveOptions | undefined,
  ): Promise<boolean> {
    try {
      this.checkExecution(pending.request);
      let ruleId: string | undefined;
      if (decision === "allow-persistent") {
        const current = normalizeDecision(await this.policy(pending.request));
        this.checkExecution(pending.request);
        if (current.decision === "deny" || current.requireApproval || !sameScope(current, pending.outcome)) {
          throw new PermissionDeniedError(pending.request.tool.name);
        }
        const rules = await this.matchingRules(pending.request, current, pending.definitionKey);
        this.checkExecution(pending.request);
        await this.rejectDenied(pending.request, current, rules);
        const rule = makeRule(pending.request, current, pending.definitionKey, {
          ...options!,
          decision: "allow",
        });
        await this.requireRuleStore().create(rule);
        this.checkExecution(pending.request);
        await this.emit({ type: "rule.created", rule });
        this.checkExecution(pending.request);
        ruleId = rule.id;
      }
      await this.emit({ type: "approval.resolved", requestId, decision });
      this.checkExecution(pending.request);
      if (this.pending.get(requestId) !== pending) return false;
      this.pending.delete(requestId);
      pending.removeAbortListener();
      if (sessionGrantKey !== undefined) {
        const definitions = this.sessionGrants.get(sessionGrantKey) ?? new Set<string>();
        definitions.add(sessionDefinitionKey(pending.outcome, pending.definitionKey));
        this.sessionGrants.set(sessionGrantKey, definitions);
      }
      pending.resolve({ decision, ...(ruleId === undefined ? {} : { ruleId }) });
      return true;
    } catch (error) {
      if (this.pending.get(requestId) === pending) {
        this.pending.delete(requestId);
        pending.removeAbortListener();
      }
      pending.reject(error);
      throw error;
    }
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

  private async matchingRules(
    check: PermissionCheck,
    outcome: NormalizedDecision,
    definitionKey: string,
  ): Promise<readonly PersistentPermissionRule[]> {
    if (this.ruleStore === undefined || outcome.persistent === undefined) return [];
    const rules = await this.ruleStore.list(outcome.persistent.scopeId);
    const now = Date.now();
    return rules.filter((rule) => rule.scopeId === outcome.persistent!.scopeId
      && rule.toolName === check.tool.name
      && rule.definitionKey === definitionKey
      && rule.grantKey === outcome.grantKey
      && (rule.expiresAt === undefined || rule.expiresAt > now));
  }

  private async rejectDenied(
    check: PermissionCheck,
    outcome: NormalizedDecision,
    rules: readonly PersistentPermissionRule[],
  ): Promise<void> {
    if (outcome.decision === "deny") throw new PermissionDeniedError(check.tool.name);
    const denied = rules.find((rule) => rule.decision === "deny");
    if (denied !== undefined) {
      await this.useRule(denied, check);
      throw new PermissionDeniedError(check.tool.name);
    }
  }

  private async useRule(rule: PersistentPermissionRule, check: PermissionCheck): Promise<void> {
    await this.emit({
      type: "rule.used",
      ruleId: rule.id,
      scopeId: rule.scopeId,
      decision: rule.decision,
      runId: check.context.runId,
      toolCallId: check.context.toolCallId,
    });
    this.checkExecution(check);
  }

  private async recheckRule(
    check: PermissionCheck,
    approved: NormalizedDecision,
    definitionKey: string,
    ruleId: string,
  ): Promise<void> {
    const current = normalizeDecision(await this.policy(check));
    this.checkExecution(check);
    const rules = await this.matchingRules(check, current, definitionKey);
    this.checkExecution(check);
    await this.rejectDenied(check, current, rules);
    if (current.requireApproval || !sameScope(approved, current)
      || !rules.some((rule) => rule.id === ruleId && rule.decision === "allow")) {
      throw new PermissionDeniedError(check.tool.name);
    }
  }

  private async recheckApproval(
    check: PermissionCheck,
    approved: NormalizedDecision,
    definitionKey: string,
    approval: ApprovalResolution,
  ): Promise<void> {
    const current = normalizeDecision(await this.policy(check));
    this.checkExecution(check);
    const rules = await this.matchingRules(check, current, definitionKey);
    this.checkExecution(check);
    await this.rejectDenied(check, current, rules);
    if (current.decision === "ask" && !sameScope(approved, current)) {
      throw new PermissionDeniedError(check.tool.name);
    }
    if (approval.decision === "allow-persistent") {
      const rule = rules.find((candidate) => candidate.id === approval.ruleId && candidate.decision === "allow");
      if (current.requireApproval || rule === undefined) throw new PermissionDeniedError(check.tool.name);
      await this.useRule(rule, check);
      await this.recheckRule(check, current, definitionKey, rule.id);
    }
  }

  private requireRuleStore(): PermissionRuleStore {
    if (this.ruleStore === undefined) throw new TypeError("Persistent permission rule store is not configured");
    return this.ruleStore;
  }

  private checkExecution(check: PermissionCheck): void {
    this.throwIfClosed();
    throwIfAborted(check.context.signal);
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
    try {
      await this.eventSink?.(event);
    } catch (error) {
      throw new FatalToolExecutionError(
        `Permission event persistence failed: ${errorMessage(error)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    if (payload.type === "approval.requested" && !this.pending.has(payload.request.id)) return;
    this.eventQueue.push(event);
  }
}

interface NormalizedDecision {
  decision: "allow" | "deny" | "ask";
  grantKey?: string;
  persistent?: { readonly scopeId: string; readonly description: string };
  requireApproval: boolean;
}

interface ApprovalResolution {
  readonly decision: ApprovalDecision;
  readonly ruleId?: string;
}

function normalizeDecision(value: PermissionDecision): NormalizedDecision {
  if (value === "allow" || value === "deny" || value === "ask") {
    return { decision: value, requireApproval: false };
  }
  if (
    typeof value === "object"
    && value !== null
    && (value.decision === "ask" || value.decision === "allow" || value.decision === "deny")
  ) {
    if (typeof value.grantKey !== "string" || value.grantKey.trim() === "") {
      throw new TypeError("Invalid session grant key");
    }
    if (value.requireApproval !== undefined && typeof value.requireApproval !== "boolean") {
      throw new TypeError("Invalid requireApproval flag");
    }
    if (value.requireApproval === true && value.decision !== "ask") {
      throw new TypeError("requireApproval is only valid for an ask decision");
    }
    if (value.persistent !== undefined) {
      if (typeof value.persistent !== "object" || value.persistent === null
        || typeof value.persistent.scopeId !== "string" || value.persistent.scopeId.trim() === ""
        || typeof value.persistent.description !== "string" || value.persistent.description.trim() === "") {
        throw new TypeError("Invalid persistent permission scope");
      }
    }
    return {
      decision: value.decision,
      grantKey: value.grantKey,
      requireApproval: value.requireApproval === true,
      ...(value.persistent === undefined ? {} : { persistent: Object.freeze({
        scopeId: value.persistent.scopeId,
        description: value.persistent.description,
      }) }),
    };
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
  return `approval_${crypto.randomUUID()}`;
}

function fatalPermissionError(toolName: string, error: unknown): Error {
  return new FatalToolExecutionError(
    `Permission evaluation failed for tool "${toolName}": ${errorMessage(error)}`,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown permission error";
}

function endPermissionSpan(
  span: TraceSpan | undefined,
  error: unknown,
  signal: AbortSignal,
): void {
  endTraceSpan(span, {
    status: signal.aborted || error instanceof RunCancelledError
      ? "cancelled"
      : "error",
    error: traceError(error),
  });
}

export function permissionDefinitionKey(tool: PermissionCheck["tool"]): string {
  // 递归排序，使属性顺序不同的等价 JSON Schema 使用相同 identity。
  const canonical = JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.permissionVersion === undefined ? {} : { permissionVersion: tool.permissionVersion }),
  }, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return canonical;
}

function immutableCheck(check: PermissionCheck): PermissionCheck {
  return Object.freeze({
    tool: freezeToolInput({
      name: check.tool.name,
      description: check.tool.description,
      inputSchema: structuredClone(check.tool.inputSchema),
      ...(check.tool.permissionVersion === undefined ? {} : { permissionVersion: check.tool.permissionVersion }),
    }),
    input: freezeToolInput(structuredClone(check.input)),
    context: check.context,
  });
}

function validateRuleOptions(options: ApprovalResolveOptions | undefined): asserts options is ApprovalResolveOptions {
  if (options === undefined || typeof options.createdBy !== "string" || options.createdBy.trim() === "") {
    throw new TypeError("Persistent permission rules require a trusted createdBy identity");
  }
  if (options.expiresAt !== undefined
    && (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= Date.now())) {
    throw new TypeError("Persistent permission rule expiry must be a future timestamp");
  }
}

function makeRule(
  check: PermissionCheck,
  outcome: NormalizedDecision,
  definitionKey: string,
  options: CreatePermissionRuleOptions,
): PersistentPermissionRule {
  return Object.freeze({
    id: `permission_rule_${crypto.randomUUID()}`,
    scopeId: outcome.persistent!.scopeId,
    toolName: check.tool.name,
    definitionKey,
    grantKey: outcome.grantKey!,
    description: outcome.persistent!.description,
    decision: options.decision,
    createdAt: Date.now(),
    createdBy: options.createdBy,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });
}

function sameScope(left: NormalizedDecision, right: NormalizedDecision): boolean {
  return left.grantKey === right.grantKey
    && left.persistent?.scopeId === right.persistent?.scopeId
    && left.requireApproval === right.requireApproval;
}

function sessionDefinitionKey(outcome: NormalizedDecision, definitionKey: string): string {
  return JSON.stringify([outcome.persistent?.scopeId ?? null, definitionKey]);
}
