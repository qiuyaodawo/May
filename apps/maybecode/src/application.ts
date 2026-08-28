import { resolve } from "node:path";

import { createCodingTools } from "@may/coding-tools";
import {
  InMemoryContextFactory,
  type ContextBudget,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextController,
  type ContextFactory,
  type ContextInspection,
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
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  readonly maxSteps?: number;
}

export class MaybeCodeApplication {
  readonly events: AsyncIterable<MaybeCodeSessionEvent>;
  readonly sessionId: string;
  readonly workspace: string;
  readonly instructions: MaybeCodeInstructions;

  private readonly session: Session;
  private readonly permissions: PermissionToolExecutor;
  private readonly contextController: ContextController | undefined;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeSessionEvent>();
  private readonly permissionRelay: Promise<void>;
  private readonly runRelays = new Set<Promise<void>>();
  private currentRun: MaybeCodeRun | undefined;
  private starting = false;
  private closed = false;

  private constructor(
    workspace: string,
    session: Session,
    permissions: PermissionToolExecutor,
    instructions: MaybeCodeInstructions,
    contextController: ContextController | undefined,
  ) {
    this.workspace = workspace;
    this.session = session;
    this.sessionId = session.id;
    this.permissions = permissions;
    this.instructions = instructions;
    this.contextController = contextController;
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
    const contextBudget = options.contextBudget ?? contextBudgetFromModel(
      options.model,
    );
    let contextController: ContextController | undefined;
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
      );
      return application;
    } catch (error) {
      await permissions.close();
      throw error;
    }
  }

  get isRunning(): boolean {
    return this.starting || this.currentRun !== undefined;
  }

  async submit(options: RunOptions): Promise<MaybeCodeRun> {
    this.throwIfClosed();
    if (this.isRunning) {
      throw new Error("A MaybeCode run is already active");
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
    if (this.currentRun === undefined) return false;
    this.currentRun.cancel(reason);
    return true;
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
    strategy?: ContextCompactionStrategy,
  ): Promise<ContextCompactionResult> {
    this.throwIfClosed();
    if (this.isRunning) {
      throw new Error("Cannot compact context while a run is active");
    }
    if (this.contextController?.compact === undefined) {
      throw new Error("Context compaction is not supported by the active context");
    }

    const result = await this.contextController.compact(strategy);
    if (result.changed) {
      await this.session.recordContextCompaction({
        strategy: result.strategy,
        messages: result.messages,
        beforeMessageCount: result.before.messageCount,
        afterMessageCount: result.after.messageCount,
        beforeEstimatedTokens: result.before.estimatedTokens,
        afterEstimatedTokens: result.after.estimatedTokens,
      });
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const active = this.currentRun;
    active?.cancel("MaybeCode is closing");
    await active?.result.catch(() => undefined);
    await this.permissions.close("MaybeCode is closing");
    await Promise.all([...this.runRelays]);
    await this.permissionRelay;
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
