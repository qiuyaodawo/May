import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectGitWorkspace } from "@may/application/git-workspace";
import { requestMainRunIds, startGitGoalRequest, startGitRequest } from "./git-request.js";
import { mediaHistory } from "./media-history.js";
import type { SkillRegistry } from "@may/skills";

import {
  applicationServices,
  defineAgent,
  withDefaultCompactionThreshold,
} from "@may/application";
import type {
  AgentApplication,
  AgentApplicationEvent,
  AgentRun,
  AgentApplicationFork,
} from "@may/application";
import {
  createToolChangePreview,
  decodeToolChangePreviewPresentation,
  TOOL_CHANGE_PREVIEW_PRESENTATION_KIND,
  TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION,
} from "@may/coding-tools";
import {
  type ContextBudget,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextSummarizer,
  type ContextFactory,
  type ContextInspection,
  PruneOldToolResultsStrategy,
} from "@may/context";
import {
  AsyncEventQueue,
  RunCancelledError,
  isStreamingMayEvent,
  ToolRegistry,
  type Model,
  type RunOptions,
  type RunBudget,
  type Tool,
  type TraceAttributes,
  type Tracer,
  type UserMessage,
} from "@may/core";
import type { ApprovalDecision, PermissionPolicy, PermissionRuleStore, PersistentApprovalOptions, PermissionCheck, CreatePermissionRuleOptions } from "@may/permissions";
import type { MaybeCodePermissionMode } from "./policy.js";
import type { AnyPlugin, ServiceToken } from "@may/plugin";
import type { McpClientPool } from "@may/mcp";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionStore,
  SessionSteerOptions,
  SessionSteeringInput,
  SessionSubmitOptions,
} from "@may/session";

import type {
  MaybeCodeAutoCompactionMode,
  MaybeCodeCompactionSelection,
  MaybeCodeModelInfo,
} from "./controller.js";
import type {
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationToolRecords,
} from "./delegation.js";
import type { MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import {
  loadMaybeCodeInstructions,
  MaybeCodeInstructionState,
  type MaybeCodeInstructions,
} from "./instructions.js";
import { HistoryReferenceMemory, historyMemoryService } from "@may/plugin-history-memory";
import { goalsService } from "@may/plugin-goals";
import { delegationService } from "@may/plugin-delegation";
import type { GoalController, GoalAgent, GoalBudget } from "@may/goal";
import { createMaybeCodePlugins, requestRecord } from "./plugins/application.js";
import { createMaybeCodeInstructionsPlugin } from "./plugins/instructions.js";
import { SubagentHost, type SubagentRequestPlan } from "./subagent-host.js";
import {
  type MaybeCodeSubagentConfiguration,
  type MaybeCodeSubagentRole,
} from "./subagents.js";

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";
export { composeMaybeCodePlugins, createMaybeCodePlugins } from "./plugins/application.js";

/** MaybeCode 主 Run 的默认步数上限；显式 maxSteps 覆盖该值。 */
const MAYBECODE_MAX_STEPS = 32;

/** 子 Agent 默认启用；宿主可以显式关闭或替换角色与限制。 */
export interface MaybeCodeSubagentOptions {
  /** 缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 缺省时使用 Session 存储目录下的 subagents。 */
  readonly dataDirectory?: string;
  /** 声明了自己 model profile 的角色使用的宿主模型工厂。 */
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model | undefined;
  /** 角色自有模型的上下文预算；没有配置时继承主会话。 */
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
  readonly toolSource?: () => Iterable<Tool>;
}

export interface MaybeCodeApplicationOptions {
  readonly gitWorkspace?: ProjectGitWorkspace;
  readonly onGitCheckpoint?: (checkpoint: import("@may/application/git-workspace").GitCheckpoint) => void;
  readonly plugins?: readonly AnyPlugin[];
  readonly workspace: string;
  readonly model?: Model;
  readonly modelInfo?: MaybeCodeModelInfo;
  readonly modelRuntimeOptions?: Readonly<Record<string, unknown>>;
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly fork?: AgentApplicationFork;
  readonly sessionMetadata?: Readonly<Record<string, unknown>>;
  readonly tools?: Iterable<Tool>;
  /** Tools appended to either the default coding tools or an explicit tool set. */
  readonly additionalTools?: Iterable<Tool>;
  /** Additional dynamic host catalog, snapshotted per Run. */
  readonly toolSource?: () => Iterable<Tool>;
  readonly permissionPolicy?: PermissionPolicy;
  readonly permissionRuleStore?: PermissionRuleStore;
  readonly permissionScopeId?: string;
  readonly permissionModeSource?: () => MaybeCodePermissionMode;
  readonly tracer?: Tracer;
  readonly traceAttributes?: TraceAttributes;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Defaults to prune-summary; explicit strategies override this mode. */
  readonly autoCompactionMode?: MaybeCodeAutoCompactionMode;
  /** @deprecated Use autoCompactionMode: "provider-native" for native-only compaction. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  /** 主 Run 的步数上限，缺省为 32。 */
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly skillDirectories?: readonly string[];
  readonly goals?: false;
  /** false 关闭子 Agent 委派；缺省启用并注册 worker 角色。 */
  readonly subagents?: false | MaybeCodeSubagentOptions;
}

/**
 * MaybeCode product composition around the reusable headless agent lifecycle.
 *
 * Coding tools, prompts, permission defaults, preview presentation and named
 * compaction choices remain product policy. Session/run/approval persistence and
 * cancellation are delegated to `@may/application`.
 */
export class MaybeCodeApplication {
  readonly events: AsyncIterable<MaybeCodeSessionEvent>;
  readonly sessionId: string;
  readonly workspace: string;
  private readonly instructionState: MaybeCodeInstructionState;
  readonly modelInfo: MaybeCodeModelInfo | undefined;

  private readonly application: AgentApplication;
  private readonly manualCompactionStrategy: ContextCompactionStrategy;
  private readonly summaryTailStrategy: ContextCompactionStrategy;
  private readonly historyReferenceStrategy: ContextCompactionStrategy;
  private readonly nativeCompactionStrategy: ContextCompactionStrategy | undefined;
  private readonly historyMemory: HistoryReferenceMemory;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeSessionEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) =>
      value.type === "run.event" && isStreamingMayEvent(value.event),
  });
  private readonly eventRelay: Promise<void>;
  private readonly subagentRelay: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private inputTail: Promise<void> = Promise.resolve();
  private inputOperations = 0;
  private currentRun: MaybeCodeRun | undefined;
  private gitWorkspace: ProjectGitWorkspace | undefined;
  private permissionScopeId: string | undefined;
  private compaction: Promise<ContextCompactionResult> | undefined;
  private inputEpoch = 0;
  private steeringCancellation: Promise<void> = Promise.resolve();
  readonly goals: GoalController | undefined;
  readonly subagents: SubagentHost | undefined;
  private readonly removeGoalListener: (() => void) | undefined;

  private constructor(
    workspace: string,
    application: AgentApplication,
    instructions: MaybeCodeInstructionState,
    manualCompactionStrategy: ContextCompactionStrategy,
    summaryTailStrategy: ContextCompactionStrategy,
    historyReferenceStrategy: ContextCompactionStrategy,
    nativeCompactionStrategy: ContextCompactionStrategy | undefined,
    historyMemory: HistoryReferenceMemory,
    modelInfo: MaybeCodeModelInfo | undefined,
    goals: GoalController | undefined,
    subagents: SubagentHost | undefined,
    readonly mcp: McpClientPool | undefined,
  ) {
    this.workspace = workspace;
    this.application = application;
    this.sessionId = application.sessionId;
    this.instructionState = instructions;
    this.manualCompactionStrategy = manualCompactionStrategy;
    this.summaryTailStrategy = summaryTailStrategy;
    this.historyReferenceStrategy = historyReferenceStrategy;
    this.nativeCompactionStrategy = nativeCompactionStrategy;
    this.historyMemory = historyMemory;
    this.modelInfo = modelInfo === undefined ? undefined : { ...modelInfo };
    this.goals = goals;
    this.subagents = subagents;
    this.removeGoalListener = goals?.subscribe(event => {
      this.eventQueue.push(event);
      if (!goals.isRunning) void this.resumeSteering();
    });
    this.events = this.eventQueue;
    this.eventRelay = this.relayEvents(application.events);
    this.subagentRelay = subagents === undefined ? undefined : this.relaySubagentEvents(subagents.events);
  }

  static async open(
    options: MaybeCodeApplicationOptions,
  ): Promise<MaybeCodeApplication> {
    const workspace = resolve(options.workspace);
    const configuredTools = ToolRegistry.compose(
      options.tools ?? [],
      options.additionalTools ?? [],
    );
    const created = options.resume && options.sessionId && options.store.inspect ? (await options.store.inspect(options.sessionId))[0] : undefined;
    const sessionMetadata = options.sessionMetadata ?? (created?.type === "session.created" ? created.metadata : undefined);
    const fork = sessionMetadata?.workspaceFork as { sourceWorkspace?: string } | undefined;
    const forkOrigin = options.fork ?? (created?.type === "session.created" ? created.fork : undefined);
    const instructions = await loadMaybeCodeInstructions({
      workspace,
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(options.instructionsDirectory === undefined
        ? {}
        : { instructionsDirectory: options.instructionsDirectory }),
    });
    const instructionState = new MaybeCodeInstructionState(workspace, instructions);
    const instructionPlugin = createMaybeCodeInstructionsPlugin(instructionState, {
      workspace, options, historicalBranch: forkOrigin !== undefined || fork !== undefined,
      ...(forkOrigin === undefined ? {} : { historicalSource: forkOrigin.sessionId }),
    }, configuredTools);

    const contextBudget = withDefaultCompactionThreshold(
      options.contextBudget,
    );
    const initialModelInfo = options.plugins?.some(plugin => plugin.provides?.some(service =>
      service.id === applicationServices.model.id && service.scope === applicationServices.model.scope))
      ? undefined : options.modelInfo;

    let product: MaybeCodeApplication | undefined;
    const composition = createMaybeCodePlugins({ ...options,
      plugins: [instructionPlugin, ...(options.plugins ?? [])],
      onGitCheckpoint: checkpoint => {
        options.onGitCheckpoint?.(checkpoint);
        if (!product) throw new Error("Git checkpoint completed before the MaybeCode application was ready");
        product.eventQueue.push({ type: "workspace.git.changed", checkpoint });
      },
    }, {
      workspace,
      instructions: instructions.system.content,
      instructionsSource: () => instructionState.current.system.content,
      projectInstructionsSource: () => instructionState.projectInstructions(),
      prepareInstructions: () => instructionState.refreshProject(),
      ...(contextBudget === undefined ? {} : { contextBudget }),
    });
    const definition = defineAgent({
      plugins: composition.plugins,
      forkStateKeys: ["maybecode.context-notes", "maybecode.model"],
      forkPluginIds: ["may.history-memory"],
      forkStateTransform: (key, value) => migrateForkSkillState(key, value, fork?.sourceWorkspace, workspace),
      tools: configuredTools,
      toolScope: { workspaceId: resolve(options.workspace) },
      ...(options.permissionRuleStore === undefined ? {} : { permissionRuleStore: options.permissionRuleStore }),
      instructions: instructions.system.content,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.agent.name": "maybecode",
        ...(initialModelInfo?.profile === undefined
          ? {}
          : { "may.model.profile": initialModelInfo.profile }),
        ...(initialModelInfo?.provider === undefined
          ? {}
          : { "may.model.provider": initialModelInfo.provider }),
        ...(initialModelInfo?.adapter === undefined
          ? {}
          : { "may.model.adapter": initialModelInfo.adapter }),
        ...(initialModelInfo?.model === undefined
          ? {}
          : { "may.model.name": initialModelInfo.model }),
      },
      maxSteps: options.maxSteps ?? MAYBECODE_MAX_STEPS,
      ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
      sessionHistory: { retrieval: true },
      createToolPresentation: async (check) => {
        const preview = await createToolChangePreview(
          workspace,
          check.tool.name,
          check.input,
        );
        return preview === undefined
          ? undefined
          : {
              kind: TOOL_CHANGE_PREVIEW_PRESENTATION_KIND,
              version: TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION,
              data: preview,
            };
      },
      validateSession: (metadata) => assertWorkspace(metadata, workspace),
      closeReason: "MaybeCode is closing",
    });
    const application = await definition.open({
      store: options.store,
      metadata: { ...options.sessionMetadata, workspace },
      contextMetadata: { workspace },
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.fork === undefined ? {} : { fork: options.fork }),
    });
    const history = application.getService(historyMemoryService);
    product = new MaybeCodeApplication(
      workspace,
      application,
      instructionState,
      history.manual,
      history.summary,
      history.historyReference,
      history.native,
      history.memory,
      composition.modelInfo,
      composition.hasGoals ? application.getService(goalsService) : undefined,
      composition.hasDelegation ? application.getService(delegationService).get() : undefined,
      composition.mcp,
    );
    product.gitWorkspace = options.gitWorkspace;
    product.permissionScopeId = options.permissionRuleStore === undefined ? undefined
      : options.permissionScopeId ?? `maybecode:${workspace}:main`;
    if (composition.modelInfo !== undefined) {
      try { await application.recordState("maybecode.model", {
        provider: composition.modelInfo.provider, model: composition.modelInfo.model,
        ...(composition.modelInfo.adapter === undefined ? {} : { adapter: composition.modelInfo.adapter }),
        ...(composition.modelInfo.profile === undefined ? {} : { profile: composition.modelInfo.profile }),
        runtimeOptions: typeof options.modelRuntimeOptions?.reasoningEffort === "string"
          ? { reasoningEffort: options.modelRuntimeOptions.reasoningEffort } : {},
      }); }
      catch (error) { await product.close(); throw error; }
    }
    return product;
  }

  get isRunning(): boolean {
    return this.inputOperations > 0 || this.currentRun !== undefined || this.application.isRunning ||
      this.goals?.isRunning === true || this.subagents?.isRunning === true;
  }

  get instructions(): MaybeCodeInstructions {
    return { ...this.instructionState.current,
      effective: this.application.getService(applicationServices.instructionSources).snapshot() };
  }

  submit(options: SessionSubmitOptions): Promise<MaybeCodeRun> {
    const epoch = this.inputEpoch;
    return this.serializeInput(async () => {
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before execution");
      options.signal?.throwIfAborted();
      const run = this.currentRun, compaction = this.compaction;
      const goalPause = this.goals?.isRunning ? this.goals.pause("Paused for a new user message") : undefined;
      if (run || compaction) {
        this.historyMemory.cancelRequest();
        this.application.cancel("Interrupted by a new user message");
        await this.subagents?.cancel("Interrupted by a new user message");
      }
      await this.application.cancelSteeringInputs("Replaced by a new user message");
      await goalPause;
      await Promise.allSettled([...(run ? [run.result] : []), ...(compaction ? [compaction] : [])]);
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before execution");
      options.signal?.throwIfAborted();
      const next = this.track(await this.startRequest({
        mode: "submit",
        input: options.input,
        record: requestRecord(options.input),
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
        ...(options.shouldYield === undefined ? {} : { shouldYield: options.shouldYield }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.traceAttributes === undefined ? {} : { traceAttributes: options.traceAttributes }),
      }, options));
      if (epoch !== this.inputEpoch) { next.cancel("Input cancelled during startup"); await next.result.catch(() => undefined); }
      return next;
    });
  }

  steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    const epoch = this.inputEpoch;
    return this.serializeInput(async () => {
      if (epoch !== this.inputEpoch) throw new RunCancelledError("Input cancelled before acceptance");
      await this.steeringCancellation;
      const input = await this.application.steer(options);
      if (epoch !== this.inputEpoch) { await this.steeringCancellation; return this.application.listSteeringInputs().find(item => item.inputId === input.inputId)!; }
      if (input.status === "idle" && !this.goals?.isRunning && this.subagents?.isRunning !== true) {
        const run = this.track(await this.startRequest({
          mode: "steer",
          input: input.message,
          inputId: input.inputId,
          record: `Steering input ${input.inputId}`,
        }, undefined, input.inputId));
        if (epoch !== this.inputEpoch) run.cancel("Input cancelled during startup");
      }
      return this.application.listSteeringInputs().find(item => item.inputId === input.inputId)!;
    });
  }

  listSteeringInputs(): readonly SessionSteeringInput[] { return this.application.listSteeringInputs(); }

  private serializeInput<T>(operation: () => Promise<T>, allowClosed = false): Promise<T> {
    this.inputOperations++;
    const result = this.inputTail.then(() => {
      if (this.closed && !allowClosed) throw new Error("MaybeCode is closed");
      return operation();
    });
    this.inputTail = result.then(() => { this.inputOperations--; }, () => { this.inputOperations--; });
    return result;
  }

  private track(run: MaybeCodeRun): MaybeCodeRun {
    this.currentRun = run;
    const settled = () => {
      if (this.currentRun === run) this.currentRun = undefined;
      void this.resumeSteering();
    };
    void run.result.then(settled, settled);
    return run;
  }

  private async resumeSteering(): Promise<void> {
    if (this.closed || !this.application.listSteeringInputs().some(input => input.status === "idle")) return;
    const epoch = this.inputEpoch;
    await this.serializeInput(async () => {
      if (this.closed || epoch !== this.inputEpoch || this.application.isRunning ||
        this.goals?.isRunning || this.subagents?.isRunning) return;
      await this.steeringCancellation;
      if (this.closed || epoch !== this.inputEpoch) return;
      const input = this.application.listSteeringInputs().find(item => item.status === "idle");
      if (input) {
        this.track(await this.startRequest({
          mode: "steer",
          input: input.message,
          inputId: input.inputId,
          record: `Steering input ${input.inputId}`,
        }, undefined, input.inputId));
      }
    }, true);
  }

  getGoal() { return this.goals?.getGoal(); }
  getService<T>(service: ServiceToken<T>): T { return this.application.getService(service); }
  getOptionalService<T>(service: ServiceToken<T>): T | undefined { return this.application.getOptionalService(service); }
  startGoal(objective: string, budget?: GoalBudget) { return this.requireGoals().start(objective, budget); }
  resumeGoal() { return this.requireGoals().resume(); }
  pauseGoal() { return this.requireGoals().pause(); }
  cancelGoal() { return this.requireGoals().cancel(); }
  private requireGoals(): GoalController {
    if (!this.goals) throw new Error("Goals are disabled in this application");
    return this.goals;
  }

  retry(): Promise<MaybeCodeRun> {
    if (this.goals?.isRunning) throw new Error("Pause the goal before retrying a run");
    if (this.subagents?.isRunning === true) {
      throw new Error("Wait for the current request to finish, or cancel it, before retrying");
    }
    return this.serializeInput(async () => this.track(await this.startRequest({
      mode: "continue",
      input: "",
      record: "Retry the latest failed Run of this Session",
    })));
  }

  /** 启动一次用户请求；未启用委派时启动一个普通 Run。 */
  private async startRequest(
    plan: SubagentRequestPlan & { readonly mode: "submit" | "continue" | "steer" },
    options?: SessionSubmitOptions,
    inputId?: string,
  ): Promise<MaybeCodeRun> {
    return startGitRequest(this.gitWorkspace, this.sessionId,
      () => this.startRequestRun(plan, options, inputId),
      checkpoint => this.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
      async runId => (await this.application.branchPositions()).find(position => position.runId === runId)?.positionSeq,
      async firstRunId => requestMainRunIds(await this.application.history(), firstRunId));
  }

  private async startRequestRun(
    plan: SubagentRequestPlan & { readonly mode: "submit" | "continue" | "steer" },
    options?: SessionSubmitOptions,
    inputId?: string,
  ): Promise<MaybeCodeRun> {
    if (this.subagents !== undefined) {
      return this.subagents.start({
        input: plan.input,
        record: plan.record,
        ...(inputId === undefined ? {} : { inputId }),
        ...(plan.runBudget === undefined ? {} : { runBudget: plan.runBudget }),
        ...(plan.shouldYield === undefined ? {} : { shouldYield: plan.shouldYield }),
        ...(plan.signal === undefined ? {} : { signal: plan.signal }),
        ...(plan.traceAttributes === undefined ? {} : { traceAttributes: plan.traceAttributes }),
      }, plan.mode === "continue" ? "continue" : "submit");
    }
    if (plan.mode === "continue") return this.plainRun(await this.application.retry());
    if (plan.mode === "steer") {
      return this.plainRun(await this.application.startSteeringInput(inputId!));
    }
    return this.plainRun(await this.application.submit(options!));
  }

  /** 没有委派的单个 Run 同样以一次请求的身份报告。 */
  private plainRun(run: AgentRun): MaybeCodeRun {
    const sessionId = this.sessionId;
    return {
      id: run.id,
      requestId: `run-${run.id}`,
      result: run.result,
      ...(run.traceContext === undefined ? {} : { traceContext: run.traceContext }),
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
        return owner.application.isRunning || owner.subagents?.isRunning === true;
      },
      submit: (options) => startGitGoalRequest(owner.gitWorkspace, owner.sessionId, () => owner.startRequestRun({
        mode: "submit",
        input: options.input,
        record: requestRecord(options.input),
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
        ...(options.shouldYield === undefined ? {} : { shouldYield: options.shouldYield }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, { ...options, input: options.input }),
        checkpoint => owner.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
        runId => owner.application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await owner.application.branchPositions()).find(position => position.runId === runId)?.positionSeq,
        async firstRunId => requestMainRunIds(await owner.application.history(), firstRunId)),
      continue: (options) => startGitGoalRequest(owner.gitWorkspace, owner.sessionId, () => owner.subagents ? owner.startRequestRun({
        mode: "continue",
        input: "",
        record: "Continue the active goal",
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
        ...(options.shouldYield === undefined ? {} : { shouldYield: options.shouldYield }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }) : owner.application.continue(options),
        checkpoint => owner.eventQueue.push({ type: "workspace.git.changed", checkpoint }),
        runId => owner.application.saveBranchPosition(runId, { allowYielded: true }),
        async runId => (await owner.application.branchPositions()).find(position => position.runId === runId)?.positionSeq,
        async firstRunId => requestMainRunIds(await owner.application.history(), firstRunId)),
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
    if (request) void this.subagents?.cancel(reason ?? "Cancelled by user");
    const pending = this.inputOperations > 0 || this.application.listSteeringInputs().some(input => input.status === "pending" || input.status === "idle");
    this.steeringCancellation = this.application.cancelSteeringInputs(reason);
    this.historyMemory.cancelRequest();
    if (this.goals?.interrupt(reason)) return true;
    return this.application.cancel(reason) || pending || request;
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
    options?: PersistentApprovalOptions,
  ): Promise<boolean> {
    const subagent = this.subagents?.resolveApproval(requestId, decision);
    return subagent === undefined
      ? this.application.resolveApproval(requestId, decision, options)
      : subagent.then(resolved => resolved || this.application.resolveApproval(requestId, decision, options));
  }

  get persistentRulesEnabled(): boolean { return this.permissionScopeId !== undefined; }
  async listPermissionRules(scopeId?: string) {
    if (this.permissionScopeId === undefined) throw new Error("持久权限规则没有启用。");
    if (scopeId !== undefined && scopeId !== this.permissionScopeId) throw new Error("权限规则范围不属于当前宿主。");
    return this.application.listPermissionRules(this.permissionScopeId);
  }
  createPermissionRule(check: PermissionCheck, options: CreatePermissionRuleOptions) { return this.application.createPermissionRule(check, options); }
  async createPermissionRuleFrom(id: string, options: CreatePermissionRuleOptions) {
    if (!(await this.listPermissionRules()).some(rule => rule.id === id)) throw new Error("规则不属于当前宿主。");
    return this.application.createPermissionRuleFrom(id, options);
  }
  async revokePermissionRule(id: string) {
    if (!(await this.listPermissionRules()).some(rule => rule.id === id)) return false;
    return this.application.revokePermissionRule(id);
  }

  async history() {
    return mediaHistory(await this.application.history());
  }

  listRecoveries() { return this.application.listRecoveries(); }
  get skills() { return this.application.skills; }
  activateSkill(name: string) {
    if (this.isRunning) throw new Error("Cannot activate a skill while an operation is active");
    return this.application.activateSkill(name);
  }
  resolveRecovery(id: string, finding: string) {
    if (this.isRunning) throw new Error("Cannot resolve recovery while an operation is active");
    return this.application.resolveRecovery(id, finding);
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.application.queryHistory(query);
  }

  branchPositions() {
    return this.application.branchPositions();
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.application.inspectContext();
  }

  compactContext(
    selection?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    if (this.subagents?.isRunning === true || this.goals?.isRunning === true) {
      throw new Error("Cannot compact context while a request or goal is active");
    }
    const result = this.application.compactContext(
      this.resolveCompactionStrategy(selection),
    );
    this.compaction = result;
    const finished = () => { if (this.compaction === result) this.compaction = undefined; };
    void result.then(finished, finished);
    return result;
  }

  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    try {
      await this.steeringCancellation;
      await this.application.close();
      await this.inputTail;
      await this.eventRelay;
      await this.subagentRelay;
    } finally {
      this.removeGoalListener?.();
      this.eventQueue.close();
    }
  }

  private async relaySubagentEvents(
    events: AsyncIterable<import("./delegation.js").MaybeCodeDelegationEvent>,
  ): Promise<void> {
    for await (const event of events) this.eventQueue.push(event);
  }

  private async relayEvents(
    events: AsyncIterable<AgentApplicationEvent>,
  ): Promise<void> {
    for await (const event of events) {
      if (event.type !== "tool.presentation") {
        this.eventQueue.push(event);
        continue;
      }
      const value = event.presentation;
      const preview = decodeToolChangePreviewPresentation(
        value.kind,
        value.version,
        value.data,
      );
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

  private resolveCompactionStrategy(
    selection: MaybeCodeCompactionSelection | undefined,
  ): ContextCompactionStrategy {
    if (selection === undefined) return this.manualCompactionStrategy;
    if (selection === "prune-old-tool-results") {
      return new PruneOldToolResultsStrategy();
    }
    if (selection === "summary-tail") return this.summaryTailStrategy;
    if (selection === "history-reference") return this.historyReferenceStrategy;
    if (selection === "provider-native") return requireNativeCompaction(this.nativeCompactionStrategy);
    if (typeof selection === "object") return selection;
    throw new Error(`Unknown context compaction strategy: ${String(selection)}`);
  }
}

function requireNativeCompaction(
  strategy: ContextCompactionStrategy | undefined,
): ContextCompactionStrategy {
  if (strategy === undefined) {
    throw new Error("The active model does not support provider-native context compaction");
  }
  return strategy;
}

function assertWorkspace(
  metadata: Readonly<Record<string, unknown>> | undefined,
  workspace: string,
): void {
  const stored = metadata?.workspace;
  if (
    typeof stored === "string" &&
    normalizePath(stored) !== normalizePath(workspace)
  ) {
    throw new Error(`Session belongs to another workspace: ${stored}`);
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function migrateForkSkillState(key: string, value: unknown, sourceWorkspace: string | undefined, workspace: string): unknown {
  if (sourceWorkspace === undefined || normalizePath(sourceWorkspace) === normalizePath(workspace)) return value;
  const migrate = (documents: unknown): unknown => {
    if (!Array.isArray(documents)) return documents;
    return documents.map((document) => {
      if (typeof document !== "object" || document === null || typeof document.directory !== "string") return document;
      const path = relative(sourceWorkspace, document.directory);
      if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return document;
      return { ...document, directory: resolve(workspace, path) };
    });
  };
  if (key === "may.skills.active.v1") return migrate(value);
  if (key !== "may.plugins" || typeof value !== "object" || value === null) return value;
  const state = value as { application: Readonly<Record<string, { value: unknown }>>; session: Readonly<Record<string, { value: unknown }>> };
  const migrateScope = (scope: typeof state.application) => Object.fromEntries(Object.entries(scope).map(([id, record]) =>
    [id, { ...record, value: migrate(record.value) }]));
  return { ...state, application: migrateScope(state.application), session: migrateScope(state.session) };
}
