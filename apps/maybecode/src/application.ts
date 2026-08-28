import { resolve } from "node:path";

import { createCodingTools } from "@may/coding-tools";
import {
  InMemoryContextFactory,
  type ContextBudget,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextSummarizer,
  type ContextController,
  type ContextFactory,
  type ContextInspection,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
} from "@may/context";
import {
  AsyncEventQueue,
  May,
  type Message,
  type Model,
  type RunOptions,
  type Tool,
} from "@may/core";
import {
  PermissionToolExecutor,
  type ApprovalDecision,
  type PermissionPolicy,
} from "@may/permissions";
import {
  Session,
  type SessionRuntimeInfo,
  type SessionStore,
} from "@may/session";

import type {
  MaybeCodeRun,
  MaybeCodeSessionEvent,
} from "./events.js";
import { createToolChangePreview } from "./diff.js";
import {
  loadMaybeCodeInstructions,
  type MaybeCodeInstructions,
} from "./instructions.js";
import { createCodingPermissionPolicy } from "./policy.js";
import { createModelContextSummarizer } from "./summarizer.js";

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";

export interface MaybeCodeApplicationOptions {
  readonly workspace: string;
  readonly model: Model;
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly tools?: readonly Tool[];
  readonly permissionPolicy?: PermissionPolicy;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  readonly maxSteps?: number;
}

export type MaybeCodeCompactionStrategyName =
  | "prune-old-tool-results"
  | "summary-tail";

export type MaybeCodeCompactionSelection =
  | MaybeCodeCompactionStrategyName
  | ContextCompactionStrategy;

interface ActiveCompaction {
  readonly controller: AbortController;
  readonly result: Promise<ContextCompactionResult>;
}

export class MaybeCodeApplication {
  readonly events: AsyncIterable<MaybeCodeSessionEvent>;
  readonly sessionId: string;
  readonly workspace: string;
  readonly instructions: MaybeCodeInstructions;

  private readonly session: Session;
  private readonly permissions: PermissionToolExecutor;
  private readonly contextController: ContextController | undefined;
  private readonly summaryTailStrategy: ContextCompactionStrategy;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeSessionEvent>();
  private readonly permissionRelay: Promise<void>;
  private readonly runRelays = new Set<Promise<void>>();
  private currentRun: MaybeCodeRun | undefined;
  private activeCompaction: ActiveCompaction | undefined;
  private starting = false;
  private closed = false;

  private constructor(
    workspace: string,
    session: Session,
    permissions: PermissionToolExecutor,
    instructions: MaybeCodeInstructions,
    contextController: ContextController | undefined,
    summaryTailStrategy: ContextCompactionStrategy,
  ) {
    this.workspace = workspace;
    this.session = session;
    this.sessionId = session.id;
    this.permissions = permissions;
    this.instructions = instructions;
    this.contextController = contextController;
    this.summaryTailStrategy = summaryTailStrategy;
    this.events = this.eventQueue;
    this.permissionRelay = this.relayPermissionEvents();
  }

  static async open(
    options: MaybeCodeApplicationOptions,
  ): Promise<MaybeCodeApplication> {
    const workspace = resolve(options.workspace);
    const instructions = await loadMaybeCodeInstructions({
      workspace,
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(options.instructionsDirectory === undefined
        ? {}
        : { instructionsDirectory: options.instructionsDirectory }),
    });
    const permissionPolicy = options.permissionPolicy ??
      createCodingPermissionPolicy();
    let application: MaybeCodeApplication | undefined;
    const permissions = new PermissionToolExecutor({
      policy: async (check) => {
        const preview = await createToolChangePreview(
          workspace,
          check.tool.name,
          check.input,
        );
        if (preview !== undefined) {
          application?.eventQueue.push({
            type: "change.preview",
            runId: check.context.runId,
            step: check.context.step,
            toolCallId: check.context.toolCallId,
            preview,
          });
        }
        return permissionPolicy(check);
      },
    });
    const tools = [...(options.tools ?? createCodingTools({ cwd: workspace }))];
    const contextFactory = options.contextFactory ?? new InMemoryContextFactory();
    const contextBudget = withDefaultCompactionThreshold(
      options.contextBudget ?? contextBudgetFromModel(options.model),
    );
    let contextController: ContextController | undefined;
    const summaryTailStrategy = new SummaryTailStrategy({
      summarizer: options.contextSummarizer ??
        createModelContextSummarizer(options.model),
    });
    const autoCompactionStrategies = options.autoCompactionStrategies ?? [
      new PruneOldToolResultsStrategy(),
      summaryTailStrategy,
    ];
    const createRuntime = async (
      messages: Message[] = [],
      runtimeInfo: SessionRuntimeInfo = {},
    ) => {
      const managedContext = await contextFactory.create({
        instructions: instructions.effective,
        messages,
        metadata: { workspace },
        ...(contextBudget === undefined
          ? {}
          : { budget: contextBudget }),
        ...(runtimeInfo.latestModelMeasurement === undefined
          ? {}
          : { measurement: runtimeInfo.latestModelMeasurement }),
        ...(options.compactionStrategy === undefined
          ? {}
          : { compactionStrategy: options.compactionStrategy }),
        autoCompactionStrategies,
      });
      contextController = managedContext.controller;
      return new May({
        model: options.model,
        tools,
        context: managedContext.context,
        toolExecutor: permissions,
        ...(options.maxSteps === undefined
          ? {}
          : { maxSteps: options.maxSteps }),
      });
    };

    try {
      const session = options.resume === true
        ? await resumeSession(options, createRuntime)
        : await Session.create({
            runtime: await createRuntime(),
            store: options.store,
            metadata: { workspace },
            ...(options.sessionId === undefined
              ? {}
              : { id: options.sessionId }),
          });
      assertWorkspace(session, workspace);
      permissions.setEventSink((event) => session.recordPermissionEvent(event));
      application = new MaybeCodeApplication(
        workspace,
        session,
        permissions,
        instructions,
        contextController,
        summaryTailStrategy,
      );
      contextController?.setAutoCompactionSink?.((result) =>
        application!.recordAutomaticCompaction(result)
      );
      return application;
    } catch (error) {
      await permissions.close();
      throw error;
    }
  }

  get isRunning(): boolean {
    return this.starting ||
      this.currentRun !== undefined ||
      this.activeCompaction !== undefined;
  }

  async submit(options: RunOptions): Promise<MaybeCodeRun> {
    this.throwIfClosed();
    if (this.isRunning) {
      throw new Error("A MaybeCode operation is already active");
    }

    this.starting = true;
    try {
      const run = await this.session.submit(options);
      const relay = this.relayRunEvents(run.events);
      this.runRelays.add(relay);
      void relay.finally(() => this.runRelays.delete(relay));

      const result = relay.then(() => run.result);
      const wrapped: MaybeCodeRun = {
        id: run.id,
        result,
        cancel: (reason?: string) => run.cancel(reason),
      };
      this.currentRun = wrapped;
      void result.then(
        () => this.clearCurrentRun(wrapped),
        () => this.clearCurrentRun(wrapped),
      );
      void result.catch(() => undefined);
      return wrapped;
    } finally {
      this.starting = false;
    }
  }

  cancel(reason = "Cancelled by user"): boolean {
    if (this.currentRun !== undefined) {
      this.currentRun.cancel(reason);
      return true;
    }
    if (this.activeCompaction !== undefined) {
      this.activeCompaction.controller.abort(reason);
      return true;
    }
    return false;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    this.throwIfClosed();
    return this.permissions.resolve(requestId, decision);
  }

  history() {
    return this.session.history();
  }

  async inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.contextController?.inspect();
  }

  async compactContext(
    selection?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    this.throwIfClosed();
    if (this.isRunning) {
      throw new Error("Cannot compact context while an operation is active");
    }
    if (this.contextController?.compact === undefined) {
      throw new Error("Context compaction is not supported by the active context");
    }

    const strategy = this.resolveCompactionStrategy(selection);
    const controller = new AbortController();
    const operation = this.performCompaction(strategy, controller.signal);
    const active: ActiveCompaction = { controller, result: operation };
    this.activeCompaction = active;
    try {
      return await operation;
    } finally {
      if (this.activeCompaction === active) this.activeCompaction = undefined;
    }
  }

  private async performCompaction(
    strategy: ContextCompactionStrategy | undefined,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult> {
    const result = await this.contextController!.compact!(strategy, { signal });
    if (result.changed) {
      await this.persistCompaction(result);
    }
    return result;
  }

  private async recordAutomaticCompaction(
    result: ContextCompactionResult,
  ): Promise<void> {
    await this.persistCompaction(result);
    this.eventQueue.push({
      type: "context.compacted",
      strategy: result.strategy,
      before: result.before,
      after: result.after,
    });
  }

  private persistCompaction(result: ContextCompactionResult): Promise<void> {
    return this.session.recordContextCompaction({
      strategy: result.strategy,
      messages: result.messages,
      beforeMessageCount: result.before.messageCount,
      afterMessageCount: result.after.messageCount,
      beforeEstimatedTokens: result.before.estimatedTokens,
      afterEstimatedTokens: result.after.estimatedTokens,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const active = this.currentRun;
    active?.cancel("MaybeCode is closing");
    await active?.result.catch(() => undefined);
    const compaction = this.activeCompaction;
    compaction?.controller.abort("MaybeCode is closing");
    await compaction?.result.catch(() => undefined);
    await this.permissions.close("MaybeCode is closing");
    await Promise.all([...this.runRelays]);
    await this.permissionRelay;
    this.contextController?.setAutoCompactionSink?.(undefined);
    this.eventQueue.close();
  }

  private async relayRunEvents(events: AsyncIterable<import("@may/core").MayEvent>) {
    for await (const event of events) {
      if (event.type === "model.completed" && event.usage !== undefined) {
        this.contextController?.recordModelUsage?.(
          event.usage,
          event.contextMessageCount,
        );
      }
      this.eventQueue.push({ type: "run.event", event });
    }
  }

  private async relayPermissionEvents(): Promise<void> {
    for await (const event of this.permissions.events) {
      this.eventQueue.push({ type: "permission.event", event });
    }
  }

  private clearCurrentRun(run: MaybeCodeRun): void {
    if (this.currentRun === run) this.currentRun = undefined;
  }

  private resolveCompactionStrategy(
    selection: MaybeCodeCompactionSelection | undefined,
  ): ContextCompactionStrategy | undefined {
    if (selection === undefined) return undefined;
    if (selection === "prune-old-tool-results") {
      return new PruneOldToolResultsStrategy();
    }
    if (selection === "summary-tail") return this.summaryTailStrategy;
    if (typeof selection === "object") return selection;
    throw new Error(`Unknown context compaction strategy: ${String(selection)}`);
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode application is closed");
  }
}

async function resumeSession(
  options: MaybeCodeApplicationOptions,
  createRuntime: (
    messages?: Message[],
    runtimeInfo?: SessionRuntimeInfo,
  ) => Promise<May>,
): Promise<Session> {
  if (options.sessionId === undefined) {
    throw new Error("sessionId is required when resuming a session");
  }
  return Session.resume({
    id: options.sessionId,
    store: options.store,
    createRuntime: (messages, info) => createRuntime(messages, info),
  });
}

function assertWorkspace(session: Session, workspace: string): void {
  const stored = session.metadata?.workspace;
  if (
    typeof stored === "string" &&
    normalizePath(stored) !== normalizePath(workspace)
  ) {
    throw new Error(
      `Session "${session.id}" belongs to another workspace: ${stored}`,
    );
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contextBudgetFromModel(model: Model): ContextBudget | undefined {
  if (model.limits === undefined) return undefined;
  return {
    ...(model.limits.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.limits.contextWindowTokens }),
    ...(model.limits.maxOutputTokens === undefined
      ? {}
      : { outputReserveTokens: model.limits.maxOutputTokens }),
  };
}

function withDefaultCompactionThreshold(
  budget: ContextBudget | undefined,
): ContextBudget | undefined {
  if (budget?.contextWindowTokens === undefined) return budget;
  if (budget.compactTriggerRatio !== undefined) return budget;
  return {
    ...budget,
    compactTriggerRatio: 0.9,
  };
}
