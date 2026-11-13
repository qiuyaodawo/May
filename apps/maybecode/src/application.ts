import type { LanguageServerManager } from "@sortedyuan/lsp-tools";
import type { GitCheckpoint } from "@sortedyuan/may/application/git-workspace";
import { type GitRequestController, requestMainRunIds, startGitGoalRequest, startGitRequest } from "./git-request.js";
import { mediaHistory } from "./media-history.js";

import { applicationServices } from "@sortedyuan/may";
import type { AgentApplication, AgentApplicationEvent, AgentRun } from "@sortedyuan/may";
import { decodeToolChangePreviewPresentation, type CodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import {
  type ContextBudget,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextInspection,
  PruneOldToolResultsStrategy,
} from "@sortedyuan/may/context";
import {
  AsyncEventQueue,
  hasPendingServerToolInteraction,
  RunCancelledError,
  isStreamingMayEvent,
  omitUndefined,
  type Model,
  type Context,
} from "@sortedyuan/may/core";
import type {
  ApprovalDecision,
  PersistentApprovalOptions,
  PermissionCheck,
  CreatePermissionRuleOptions,
} from "@sortedyuan/may/permissions";
import type { McpClientPool } from "@sortedyuan/mcp";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionSteerOptions,
  SessionSteeringInput,
  SessionSubmitOptions,
} from "@sortedyuan/may/session";

import type { MaybeCodeCompactionSelection, MaybeCodeModelInfo, MaybeCodeSkillInfo } from "./controller.js";
import type {
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationToolRecords,
} from "@sortedyuan/coordination/delegation/types";
import type { MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import type { MaybeCodeInstructionState, MaybeCodeInstructions } from "./instructions.js";
import { historyMemoryService, type HistoryMemoryService } from "@sortedyuan/may/history-memory";
import { goalsService } from "@sortedyuan/may/goals/plugin";
import { delegationService } from "@sortedyuan/coordination/delegation";
import { mcpService } from "@sortedyuan/mcp/plugin";
import type { GoalController, GoalAgent, GoalBudget } from "@sortedyuan/may/goals";
import { requestRecord, type MaybeCodePluginComposition } from "./plugins/application.js";
import { SubagentHost, type SubagentRequestPlan } from "@sortedyuan/coordination/delegation/host";
import { openMaybeCodeApplication, type MaybeCodeApplicationOptions } from "./application-open.js";

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";
export { composeMaybeCodePlugins, createMaybeCodePlugins } from "./plugins/application.js";

export interface MaybeCodeModelUpdate {
  readonly model: Model;
  readonly modelInfo: MaybeCodeModelInfo;
  readonly modelRuntimeOptions?: Readonly<Record<string, unknown>>;
  readonly contextBudget?: ContextBudget;
}

interface MaybeCodeApplicationServices {
  readonly history: HistoryMemoryService;
  readonly modelInfo: MaybeCodeModelInfo | undefined;
  readonly goals: GoalController | undefined;
  readonly subagents: SubagentHost | undefined;
  readonly mcp: McpClientPool | undefined;
}

/**
 * MaybeCode product composition around the reusable headless agent lifecycle.
 *
 * Coding tools, prompts, permission defaults, preview presentation and named
 * compaction choices remain product policy. Session/run/approval persistence and
 * cancellation are delegated to `@sortedyuan/may`.
 */
export class MaybeCodeApplication {
  readonly events: AsyncIterable<MaybeCodeSessionEvent>;
  readonly sessionId: string;
  readonly workspace: string;
  private readonly instructionState: MaybeCodeInstructionState;
  readonly agent: AgentApplication;
  private serviceReferences: MaybeCodeApplicationServices;
  private updatingModel = false;
  private modelUpdate: Promise<void> | undefined;
  private modelUpdateFailure: unknown;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeSessionEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) => value.type === "run.event" && isStreamingMayEvent(value.event),
  });
  private readonly eventRelay: Promise<void>;
  private subagentRelay: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private inputTail: Promise<void> = Promise.resolve();
  private inputOperations = 0;
  private currentRun: MaybeCodeRun | undefined;
  private compaction: Promise<ContextCompactionResult> | undefined;
  private inputEpoch = 0;
  private steeringCancellation: Promise<void> = Promise.resolve();
  private removeGoalListener: (() => void) | undefined;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly backgroundErrors: unknown[] = [];

  private constructor(
    workspace: string,
    application: AgentApplication,
    instructions: MaybeCodeInstructionState,
    private readonly createModelPlugins: (update: MaybeCodeModelUpdate) => MaybeCodePluginComposition,
    readonly execution: CodingExecutionEnvironment,
    private readonly gitRequest: GitRequestController,
    private readonly permissionScopeId: string | undefined,
    readonly lsp?: LanguageServerManager,
    private readonly contextSource?: () => Context | undefined,
  ) {
    this.workspace = workspace;
    this.agent = application;
    this.sessionId = application.sessionId;
    this.instructionState = instructions;
    this.serviceReferences = this.readServices();
    this.events = this.readEvents();
    this.eventRelay = this.relayEvents(application.events);
    this.trackBackground(this.eventRelay);
    this.connectServiceEvents();
  }

  static open(options: MaybeCodeApplicationOptions): Promise<MaybeCodeApplication> {
    return openMaybeCodeApplication(options, (...parts) => new MaybeCodeApplication(...parts));
  }

  pushGitCheckpoint(checkpoint: GitCheckpoint): void {
    this.eventQueue.push({ type: "workspace.git.changed", checkpoint });
  }

  private readServices(): MaybeCodeApplicationServices {
    return {
      history: this.agent.getService(historyMemoryService),
      modelInfo: this.agent.getOptionalService(applicationServices.modelInfo),
      goals: this.agent.getOptionalService(goalsService),
      subagents: this.agent.getOptionalService(delegationService)?.get(),
      mcp: this.agent.getOptionalService(mcpService),
    };
  }

  get modelInfo() {
    return this.serviceReferences.modelInfo;
  }
  get goals() {
    return this.serviceReferences.goals;
  }
  get subagents() {
    return this.serviceReferences.subagents;
  }
  get mcp() {
    return this.serviceReferences.mcp;
  }
  get modelUpdateFailed(): boolean {
    return this.modelUpdateFailure !== undefined;
  }
  private get historyMemory() {
    return this.serviceReferences.history.memory;
  }

  private connectServiceEvents(): void {
    const { goals, subagents } = this.serviceReferences;
    this.removeGoalListener = goals?.subscribe((event) => {
      this.eventQueue.push(event);
      if (!this.updatingModel && !goals.isRunning) this.trackBackground(this.resumeSteering());
    });
    this.subagentRelay = subagents === undefined ? undefined : this.relaySubagentEvents(subagents.events);
    if (this.subagentRelay) this.trackBackground(this.subagentRelay);
  }

  async recordModel(runtimeOptions?: Readonly<Record<string, unknown>>): Promise<void> {
    const info = this.modelInfo;
    if (info === undefined) return;
    await this.agent.recordState("maybecode.model", {
      provider: info.provider,
      model: info.model,
      ...omitUndefined({ adapter: info.adapter, profile: info.profile }),
      runtimeOptions:
        typeof runtimeOptions?.reasoningEffort === "string" ? { reasoningEffort: runtimeOptions.reasoningEffort } : {},
    });
  }

  async updateModel(update: MaybeCodeModelUpdate): Promise<void> {
    if (this.closed) throw new Error("MaybeCode application is closed");
    if (this.isRunning || this.compaction || this.getGoal()?.status === "active") {
      throw new Error("Finish the active operation before changing the model");
    }
    if (
      [this.sessionId, ...this.ownedDelegatedSessions()].some(
        (sessionId) => this.mcp?.interactions?.list({ workspaceId: this.workspace, sessionId }).length,
      )
    ) {
      throw new Error("Finish the MCP interaction before changing the model");
    }
    this.updatingModel = true;
    const operation = (async () => {
      await this.assertModelChangeSafe();
      const composition = this.createModelPlugins(update);
      await this.replaceModelPlugins(composition, update);
    })();
    this.modelUpdate = operation;
    try {
      await operation;
    } finally {
      this.updatingModel = false;
      this.modelUpdate = undefined;
    }
  }

  async assertModelChangeSafe(): Promise<void> {
    // Failed replacements retain the Context checked before its services were suspended.
    if (this.modelUpdateFailure !== undefined) return;
    const snapshot = await this.contextSource?.()?.snapshot();
    if (snapshot && hasPendingServerToolInteraction(snapshot.messages))
      throw new Error("Continue the pending server tool interaction before changing the model");
  }

  private async replaceModelPlugins(
    composition: MaybeCodePluginComposition,
    update: MaybeCodeModelUpdate,
  ): Promise<void> {
    try {
      await this.agent.updatePlugins(composition.plugins);
      this.removeGoalListener?.();
      await this.subagentRelay;
      this.serviceReferences = this.readServices();
      this.connectServiceEvents();
      await this.recordModel(update.modelRuntimeOptions);
      this.modelUpdateFailure = undefined;
    } catch (error) {
      this.modelUpdateFailure = error;
      throw error;
    }
  }

  get isRunning(): boolean {
    return (
      this.updatingModel ||
      this.inputOperations > 0 ||
      this.currentRun !== undefined ||
      this.agent.isRunning ||
      this.goals?.isRunning === true ||
      this.subagents?.isRunning === true
    );
  }

  get instructions(): MaybeCodeInstructions {
    return {
      ...this.instructionState.current,
      effective: this.agent.getService(applicationServices.instructionSources).snapshot(),
    };
  }

  submit(options: SessionSubmitOptions): Promise<MaybeCodeRun> {
    const epoch = this.inputEpoch;
    return this.serializeInput(async () => {
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before execution");
      options.signal?.throwIfAborted();
      const run = this.currentRun,
        compaction = this.compaction;
      const goalPause = this.goals?.isRunning ? this.goals.pause("Paused for a new user message") : undefined;
      if (run || compaction) {
        this.historyMemory.cancelRequest();
        this.agent.cancel("Interrupted by a new user message");
        await this.subagents?.cancel("Interrupted by a new user message");
      }
      await this.agent.cancelSteeringInputs("Replaced by a new user message");
      await goalPause;
      await Promise.allSettled([...(run ? [run.result] : []), ...(compaction ? [compaction] : [])]);
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before execution");
      options.signal?.throwIfAborted();
      const next = this.track(
        await this.startRequest(
          omitUndefined({
            mode: "submit",
            input: options.input,
            record: requestRecord(options.input),
            runBudget: options.runBudget,
            shouldYield: options.shouldYield,
            signal: options.signal,
            traceAttributes: options.traceAttributes,
          }),
          options,
        ),
      );
      if (epoch !== this.inputEpoch) {
        next.cancel("Input cancelled during startup");
        await next.result.catch(() => undefined);
      }
      return next;
    });
  }

  steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    const epoch = this.inputEpoch;
    return this.serializeInput(async () => {
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before acceptance");
      await this.steeringCancellation;
      const input = await this.agent.steer(options);
      if (epoch !== this.inputEpoch) {
        await this.steeringCancellation;
        return this.agent.listSteeringInputs().find((item) => item.inputId === input.inputId)!;
      }
      if (input.status === "idle" && !this.goals?.isRunning && this.subagents?.isRunning !== true) {
        const run = this.track(
          await this.startRequest(
            {
              mode: "steer",
              input: input.message,
              inputId: input.inputId,
              record: `Steering input ${input.inputId}`,
            },
            undefined,
            input.inputId,
          ),
        );
        if (epoch !== this.inputEpoch) run.cancel("Input cancelled during startup");
      }
      return this.agent.listSteeringInputs().find((item) => item.inputId === input.inputId)!;
    });
  }

  private serializeInput<T>(operation: () => Promise<T>, allowClosed = false): Promise<T> {
    this.inputOperations++;
    const result = this.inputTail.then(() => {
      if (this.closed && !allowClosed) throw new Error("MaybeCode is closed");
      if (this.updatingModel) throw new Error("Finish the model update before submitting input");
      if (this.modelUpdateFailure !== undefined)
        throw new Error("Model update failed; retry the model update before continuing", {
          cause: this.modelUpdateFailure,
        });
      return operation();
    });
    this.inputTail = result.then(
      () => {
        this.inputOperations--;
      },
      () => {
        this.inputOperations--;
      },
    );
    return result;
  }

  private track(run: MaybeCodeRun): MaybeCodeRun {
    this.currentRun = run;
    const settled = () => {
      if (this.currentRun === run) this.currentRun = undefined;
      return this.resumeSteering();
    };
    this.trackBackground(run.result.then(settled, settled));
    return run;
  }

  private async resumeSteering(): Promise<void> {
    if (
      this.closed ||
      this.updatingModel ||
      this.modelUpdateFailure !== undefined ||
      !this.agent.listSteeringInputs().some((input) => input.status === "idle")
    )
      return;
    const epoch = this.inputEpoch;
    await this.serializeInput(async () => {
      if (
        this.closed ||
        epoch !== this.inputEpoch ||
        this.agent.isRunning ||
        this.goals?.isRunning ||
        this.subagents?.isRunning
      )
        return;
      await this.steeringCancellation;
      if (this.closed || epoch !== this.inputEpoch) return;
      const input = this.agent.listSteeringInputs().find((item) => item.status === "idle");
      if (input) {
        this.track(
          await this.startRequest(
            {
              mode: "steer",
              input: input.message,
              inputId: input.inputId,
              record: `Steering input ${input.inputId}`,
            },
            undefined,
            input.inputId,
          ),
        );
      }
    }, true);
  }

  getGoal() {
    return this.goals?.getGoal();
  }
  startGoal(objective: string, budget?: GoalBudget) {
    return this.requireGoals().start(objective, budget);
  }
  resumeGoal() {
    return this.requireGoals().resume();
  }
  pauseGoal() {
    return this.requireGoals().pause();
  }
  cancelGoal() {
    return this.requireGoals().cancel();
  }
  private requireGoals(): GoalController {
    if (this.updatingModel) throw new Error("Finish the model update before changing the goal");
    if (this.modelUpdateFailure !== undefined)
      throw new Error("Model update failed; retry the model update before continuing", {
        cause: this.modelUpdateFailure,
      });
    if (!this.goals) throw new Error("Goals are disabled in this application");
    return this.goals;
  }

  retry(): Promise<MaybeCodeRun> {
    if (this.goals?.isRunning) throw new Error("Pause the goal before retrying a run");
    if (this.subagents?.isRunning === true) {
      throw new Error("Wait for the current request to finish, or cancel it, before retrying");
    }
    return this.serializeInput(async () =>
      this.track(
        await this.startRequest({
          mode: "continue",
          input: "",
          record: "Retry the latest failed Run of this Session",
        }),
      ),
    );
  }

  /** 启动一次用户请求；未启用委派时启动一个普通 Run。 */
  private async startRequest(
    plan: SubagentRequestPlan & { readonly mode: "submit" | "continue" | "steer" },
    options?: SessionSubmitOptions,
    inputId?: string,
  ): Promise<MaybeCodeRun> {
    return startGitRequest(
      this.gitRequest,
      this.sessionId,
      () => this.startRequestRun(plan, options, inputId),
      (checkpoint) => this.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
      async (runId) => (await this.agent.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
      async (firstRunId) => requestMainRunIds(await this.agent.history(), firstRunId),
    );
  }

  private async startRequestRun(
    plan: SubagentRequestPlan & { readonly mode: "submit" | "continue" | "steer" },
    options?: SessionSubmitOptions,
    inputId?: string,
  ): Promise<MaybeCodeRun> {
    if (this.subagents !== undefined) {
      return this.subagents.start(
        omitUndefined({
          input: plan.input,
          record: plan.record,
          inputId,
          runBudget: plan.runBudget,
          shouldYield: plan.shouldYield,
          signal: plan.signal,
          traceAttributes: plan.traceAttributes,
        }),
        plan.mode === "continue" ? "continue" : "submit",
      );
    }
    if (plan.mode === "continue") return this.plainRun(await this.agent.retry());
    if (plan.mode === "steer") {
      return this.plainRun(await this.agent.startSteeringInput(inputId!));
    }
    return this.plainRun(await this.agent.submit(options!));
  }

  /** 没有委派的单个 Run 同样以一次请求的身份报告。 */
  private plainRun(run: AgentRun): MaybeCodeRun {
    const sessionId = this.sessionId;
    return {
      id: run.id,
      requestId: `run-${run.id}`,
      result: run.result,
      ...omitUndefined({ traceContext: run.traceContext }),
      cancel: (reason?: string) => run.cancel(reason),
      runs: async () => [{ runId: run.id, sessionId, turn: 0, result: await run.result }],
    };
  }

  /**
   * Goal 的 Run 也作为一次请求执行。
   *
   * 因此 Goal 期间的 Run 同样可以委派子任务，并且与用户输入共用同一主 Session 的
   * 单一执行方，不会出现并发写入。
   */
  goalAgent(): GoalAgent {
    const owner = this;
    return {
      sessionId: this.sessionId,
      get isRunning(): boolean {
        return owner.agent.isRunning || owner.subagents?.isRunning === true;
      },
      submit: (options) =>
        startGitGoalRequest(
          owner.gitRequest,
          owner.sessionId,
          () =>
            owner.startRequestRun(
              omitUndefined({
                mode: "submit",
                input: options.input,
                record: requestRecord(options.input),
                runBudget: options.runBudget,
                shouldYield: options.shouldYield,
                signal: options.signal,
              }),
              { ...options, input: options.input },
            ),
          (checkpoint) => owner.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
          (runId) => owner.agent.saveBranchPosition(runId, { allowYielded: true }),
          async (runId) =>
            (await owner.agent.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          async (firstRunId) => requestMainRunIds(await owner.agent.history(), firstRunId),
        ),
      continue: (options) =>
        startGitGoalRequest(
          owner.gitRequest,
          owner.sessionId,
          () =>
            owner.subagents
              ? owner.startRequestRun(
                  omitUndefined({
                    mode: "continue",
                    input: "",
                    record: "Continue the active goal",
                    runBudget: options.runBudget,
                    shouldYield: options.shouldYield,
                    signal: options.signal,
                  }),
                )
              : owner.agent.continue(options),
          (checkpoint) => owner.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
          (runId) => owner.agent.saveBranchPosition(runId, { allowYielded: true }),
          async (runId) =>
            (await owner.agent.branchPositions()).find((position) => position.runId === runId)?.positionSeq,
          async (firstRunId) => requestMainRunIds(await owner.agent.history(), firstRunId),
        ),
    };
  }

  listDelegationRequests(): readonly MaybeCodeDelegationRequest[] {
    return this.subagents?.listRequests() ?? [];
  }

  getDelegationState(): MaybeCodeDelegationState | undefined {
    return this.subagents?.requestState();
  }

  delegationToolRecords(taskId: string): Promise<MaybeCodeDelegationToolRecords> {
    if (this.subagents === undefined) throw new Error("Sub-agents are disabled in this application");
    return this.subagents.toolRecords(taskId);
  }

  resolveDelegationRecovery(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly detail: string },
  ): Promise<MaybeCodeDelegationRequest> {
    if (this.subagents === undefined) throw new Error("Sub-agents are disabled in this application");
    return this.subagents.resolveRecovery(requestId, taskId, finding, outcome);
  }

  /** 对本 Session 以及它当前持有的子 Session 返回 true。 */
  ownsSession(sessionId: string): boolean {
    return sessionId === this.sessionId || this.subagents?.ownedSessions().includes(sessionId) === true;
  }

  /** 运行中请求的子 Session，供宿主路由标签使用。 */
  ownedDelegatedSessions(): readonly string[] {
    return this.subagents?.ownedSessions() ?? [];
  }

  cancel(reason?: string): boolean {
    this.inputEpoch++;
    const request = this.subagents?.isRunning === true;
    if (request) this.trackBackground(this.subagents!.cancel(reason ?? "Cancelled by user"));
    const pending =
      this.inputOperations > 0 ||
      this.agent.listSteeringInputs().some((input) => input.status === "pending" || input.status === "idle");
    this.steeringCancellation = this.agent.cancelSteeringInputs(reason);
    this.trackBackground(this.steeringCancellation);
    this.historyMemory.cancelRequest();
    if (this.goals?.interrupt(reason)) return true;
    return this.agent.cancel(reason) || pending || request;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: PersistentApprovalOptions,
  ): Promise<boolean> {
    const subagent = this.subagents?.resolveApproval(requestId, decision);
    return subagent === undefined
      ? this.agent.resolveApproval(requestId, decision, options)
      : subagent.then((resolved) => resolved || this.agent.resolveApproval(requestId, decision, options));
  }

  get persistentRulesEnabled(): boolean {
    return this.permissionScopeId !== undefined;
  }
  async listPermissionRules(scopeId?: string) {
    if (this.permissionScopeId === undefined) throw new Error("持久权限规则没有启用。");
    if (scopeId !== undefined && scopeId !== this.permissionScopeId) throw new Error("权限规则范围不属于当前宿主。");
    return this.agent.listPermissionRules(this.permissionScopeId);
  }
  createPermissionRule(check: PermissionCheck, options: CreatePermissionRuleOptions) {
    return this.agent.createPermissionRule(check, options);
  }
  async createPermissionRuleFrom(id: string, options: CreatePermissionRuleOptions) {
    if (!(await this.listPermissionRules()).some((rule) => rule.id === id)) throw new Error("规则不属于当前宿主。");
    return this.agent.createPermissionRuleFrom(id, options);
  }
  async revokePermissionRule(id: string) {
    if (!(await this.listPermissionRules()).some((rule) => rule.id === id)) return false;
    return this.agent.revokePermissionRule(id);
  }

  async history() {
    return mediaHistory(await this.agent.history());
  }

  listRecoveries() {
    return this.agent.listRecoveries();
  }
  listSkills(): readonly MaybeCodeSkillInfo[] {
    const skills = this.agent.skills;
    const active = new Map(skills?.listActive().map((item) => [item.name, item]));
    const all = new Map(skills?.registry.list().map((item) => [item.name, item]));
    for (const [name, item] of active) all.set(name, item);
    return [...all.values()].map((item) => ({ ...item, active: active.has(item.name) }));
  }
  activateSkill(name: string) {
    if (this.isRunning) throw new Error("Cannot activate a skill while an operation is active");
    return this.agent.activateSkill(name);
  }
  resolveRecovery(id: string, finding: string) {
    if (this.isRunning) throw new Error("Cannot resolve recovery while an operation is active");
    return this.agent.resolveRecovery(id, finding);
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.agent.queryHistory(query);
  }

  branchPositions() {
    return this.agent.branchPositions();
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    if (this.modelUpdateFailure !== undefined)
      throw new Error("Model update failed; retry the model update before continuing", {
        cause: this.modelUpdateFailure,
      });
    return this.agent.inspectContext();
  }

  compactContext(selection?: MaybeCodeCompactionSelection): Promise<ContextCompactionResult> {
    if (this.updatingModel || this.subagents?.isRunning === true || this.goals?.isRunning === true) {
      throw new Error("Cannot compact context while a request or goal is active");
    }
    if (this.modelUpdateFailure !== undefined)
      throw new Error("Model update failed; retry the model update before continuing", {
        cause: this.modelUpdateFailure,
      });
    const result = this.agent.compactContext(this.resolveCompactionStrategy(selection));
    this.compaction = result;
    const finished = () => {
      if (this.compaction === result) this.compaction = undefined;
    };
    void result.then(finished, finished);
    return result;
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.removeGoalListener?.();
    try {
      if (this.modelUpdate) await Promise.allSettled([this.modelUpdate]);
      const results = await Promise.allSettled([
        this.steeringCancellation,
        this.agent.close(),
        this.inputTail,
        this.eventRelay,
        ...(this.subagentRelay ? [this.subagentRelay] : []),
      ]);
      while (this.backgroundTasks.size) await Promise.all(this.backgroundTasks);
      const failures = [
        ...new Set([
          ...this.backgroundErrors,
          ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ]),
      ];
      if (failures.length) throw new AggregateError(failures, "MaybeCode background operations failed");
    } finally {
      try {
        try {
          await this.lsp?.close();
        } finally {
          await this.execution.close();
        }
      } finally {
        this.eventQueue.close();
      }
    }
  }

  private trackBackground(operation: Promise<unknown>): void {
    const task = operation.then(
      () => {
        this.backgroundTasks.delete(task);
      },
      (error) => {
        this.backgroundTasks.delete(task);
        this.backgroundErrors.push(error);
        this.eventQueue.close();
      },
    );
    this.backgroundTasks.add(task);
  }

  private async *readEvents(): AsyncIterable<MaybeCodeSessionEvent> {
    for await (const event of this.eventQueue) yield event;
    if (this.backgroundErrors.length)
      throw new AggregateError(this.backgroundErrors, "MaybeCode background operations failed");
  }

  private async relaySubagentEvents(
    events: AsyncIterable<import("@sortedyuan/coordination/delegation/types").MaybeCodeDelegationEvent>,
  ): Promise<void> {
    for await (const event of events) this.eventQueue.push(event);
  }

  private async relayEvents(events: AsyncIterable<AgentApplicationEvent>): Promise<void> {
    for await (const event of events) {
      if (event.type !== "tool.presentation") {
        this.eventQueue.push(event);
        continue;
      }
      const value = event.presentation;
      if (value.kind === "maybecode.lsp-rename-preview") {
        this.eventQueue.push(event);
        continue;
      }
      const preview = decodeToolChangePreviewPresentation(value.kind, value.version, value.data);
      if (preview === undefined) continue;
      this.eventQueue.push({
        type: "change.preview",
        runId: value.runId,
        step: value.step,
        toolCallId: value.toolCallId,
        preview,
      });
    }
  }

  private resolveCompactionStrategy(selection: MaybeCodeCompactionSelection | undefined): ContextCompactionStrategy {
    if (selection === undefined) return this.serviceReferences.history.manual;
    if (selection === "prune-old-tool-results") {
      return new PruneOldToolResultsStrategy();
    }
    if (selection === "summary-tail") return this.serviceReferences.history.summary;
    if (selection === "history-reference") return this.serviceReferences.history.historyReference;
    if (selection === "provider-native") return requireNativeCompaction(this.serviceReferences.history.native);
    if (typeof selection === "object") return selection;
    throw new Error(`Unknown context compaction strategy: ${String(selection)}`);
  }
}

function requireNativeCompaction(strategy: ContextCompactionStrategy | undefined): ContextCompactionStrategy {
  if (strategy === undefined) {
    throw new Error("The active model does not support provider-native context compaction");
  }
  return strategy;
}
