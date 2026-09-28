import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mediaHistory } from "./media-history.js";
import { SkillRegistry } from "@may/skills";
import { defaultMaybeCodeSkillDirectories } from "./skills.js";

import {
  contextBudgetFromModel,
  defineAgent,
  withDefaultCompactionThreshold,
} from "@may/application";
import type {
  AgentApplication,
  AgentApplicationEvent,
  AgentRun,
} from "@may/application";
import {
  createToolChangePreview,
  decodeToolChangePreviewPresentation,
  getShellToolInfo,
  shellRuntimeInstructions,
  TOOL_CHANGE_PREVIEW_PRESENTATION_KIND,
  TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION,
} from "@may/coding-tools";
import {
  InMemoryContextFactory,
  ModelContextCompactionStrategy,
  type ContextBudget,
  type ContextCompactionOptions,
  type ContextCompactionOutput,
  type ContextCompactionResult,
  type ContextCompactionStrategy,
  type ContextSummarizer,
  type ContextFactory,
  type ContextInspection,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
} from "@may/context";
import {
  AsyncEventQueue,
  RunCancelledError,
  isStreamingMayEvent,
  ToolRegistry,
  type ContextSnapshot,
  type Model,
  type RunOptions,
  type RunBudget,
  type Tool,
  type TraceAttributes,
  type Tracer,
  type UserMessage,
} from "@may/core";
import type { ApprovalDecision, PermissionPolicy } from "@may/permissions";
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
  type MaybeCodeInstructions,
} from "./instructions.js";
import { createCodingPermissionPolicy } from "./policy.js";
import { createModelContextSummarizer } from "./summarizer.js";
import { HistoryReferenceMemory } from "./history-memory.js";
import { GoalController, type GoalAgent, type GoalBudget } from "@may/goal";
import { SubagentHost, type SubagentRequestPlan } from "./subagent-host.js";
import { withRequestBudget } from "./subagent-budget.js";
import {
  defaultSubagentConfiguration,
  SUBAGENT_TOOL_NAMES,
  type MaybeCodeSubagentConfiguration,
  type MaybeCodeSubagentRole,
} from "./subagents.js";
import { SharedWorkspaceFileGuard } from "./subagent-files.js";

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";

/** MaybeCode 主 Run 的默认步数上限；显式 maxSteps 覆盖该值。 */
const MAYBECODE_MAX_STEPS = 32;

/** 子 Agent 默认启用；宿主可以显式关闭或替换角色与限制。 */
export interface MaybeCodeSubagentOptions {
  /** 缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 缺省时使用 Session 存储目录下的 subagents。 */
  readonly dataDirectory?: string;
  /** 声明了自己 model profile 的角色使用的宿主模型工厂。 */
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model;
  /** 角色自有模型的上下文预算；没有配置时继承主会话。 */
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
}

/** 保存请求、任务、Session 与 Run 映射的会话状态键。 */
const REQUEST_STATE_KEY = "may.subagents";

/**
 * 子 Agent 记录与额度账本的默认根目录。
 *
 * 持久化的 Session 存储把记录放在同一棵目录下；内存存储没有可用目录，
 * 使用 MaybeCode 的默认数据目录，使请求记录仍然可以核对。
 * 宿主会在该目录下再建立 subagents 子目录。
 */
function defaultSubagentDataDirectory(store: SessionStore): string {
  return store.directory === undefined ? join(homedir(), ".may", "maybecode") : dirname(store.directory);
}

export interface MaybeCodeApplicationOptions {
  readonly workspace: string;
  readonly model: Model;
  readonly modelInfo?: MaybeCodeModelInfo;
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly tools?: Iterable<Tool>;
  /** Tools appended to either the default coding tools or an explicit tool set. */
  readonly additionalTools?: Iterable<Tool>;
  /** Additional dynamic host catalog, snapshotted per Run. */
  readonly toolSource?: () => Iterable<Tool>;
  readonly permissionPolicy?: PermissionPolicy;
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
  private readonly baseInstructions: MaybeCodeInstructions;
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
  private inputTail: Promise<void> = Promise.resolve();
  private inputOperations = 0;
  private currentRun: MaybeCodeRun | undefined;
  private compaction: Promise<ContextCompactionResult> | undefined;
  private inputEpoch = 0;
  private steeringCancellation: Promise<void> = Promise.resolve();
  readonly goals: GoalController | undefined;
  readonly subagents: SubagentHost | undefined;
  private readonly removeGoalListener: (() => void) | undefined;

  private constructor(
    workspace: string,
    application: AgentApplication,
    instructions: MaybeCodeInstructions,
    manualCompactionStrategy: ContextCompactionStrategy,
    summaryTailStrategy: ContextCompactionStrategy,
    historyReferenceStrategy: ContextCompactionStrategy,
    nativeCompactionStrategy: ContextCompactionStrategy | undefined,
    historyMemory: HistoryReferenceMemory,
    modelInfo: MaybeCodeModelInfo | undefined,
    goals: GoalController | undefined,
    subagents: SubagentHost | undefined,
  ) {
    this.workspace = workspace;
    this.application = application;
    this.sessionId = application.sessionId;
    this.baseInstructions = instructions;
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
    const autoMode = options.autoCompactionMode ??
      (options.providerNativeAutoCompaction === true ? "provider-native" : "prune-summary");
    const goals = options.goals === false ? undefined : new GoalController({
      validateBudget: budget => {
        if (budget.maxTotalTokens !== undefined && (autoMode === "provider-native" || options.contextSummarizer !== undefined || options.autoCompactionStrategies !== undefined || options.compactionStrategy !== undefined)) {
          throw new Error("Goal token budgets require built-in prune-summary or history-reference compaction with the metered model");
        }
      },
    });
    // 协作宿主先决定是否启用，主会话模型据此决定是否经过请求额度账本。
    const subagentConfiguration = options.subagents === false
      ? undefined
      : options.subagents?.configuration ?? defaultSubagentConfiguration();
    const delegation: { host?: SubagentHost } = {};
    // 子 Agent 使用没有经过额度包装的模型，包装由子 Agent 自己的定义完成，
    // 避免同一个 modelCallId 被预留两次。
    const baseModel = goals?.wrapModel(options.model) ?? options.model;
    const model = withRequestBudget(baseModel, () => delegation.host?.ledger());
    const historyMemory = new HistoryReferenceMemory(
      autoMode === "history-reference" && options.autoCompactionStrategies === undefined,
    );
    const skills = options.skills === false ? undefined : options.skills ??
      await SkillRegistry.discover(options.skillDirectories ?? defaultMaybeCodeSkillDirectories(workspace, false));
    // 主任务与子任务共用同一把文件锁；宿主自带工具对象时不参与该保护。
    const fileGuard = new SharedWorkspaceFileGuard(workspace);
    const mainFileTools = fileGuard.create({ names: [...SUBAGENT_TOOL_NAMES], requireRead: false });
    const configuredTools = ToolRegistry.compose(
      options.tools ?? mainFileTools.tools,
      options.additionalTools ?? [],
    );
    for (const tool of historyMemory.tools()) {
      if (configuredTools.has(tool.name)) throw new Error(`Tool name "${tool.name}" is reserved for session memory`);
      configuredTools.register(tool);
    }
    const shellInfo = configuredTools.values()
      .map((tool) => getShellToolInfo(tool))
      .find((info) => info !== undefined);
    const instructions = await loadMaybeCodeInstructions({
      workspace,
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(options.instructionsDirectory === undefined
        ? {}
        : { instructionsDirectory: options.instructionsDirectory }),
      ...(shellInfo === undefined
        ? {}
        : { runtimeInstructions: shellRuntimeInstructions(shellInfo) }),
    });

    const summaryTailStrategy = new SummaryTailStrategy({
      summarizer: options.contextSummarizer ??
        createModelContextSummarizer(model),
    });
    const manualCompactionStrategy = options.compactionStrategy ??
      new PruneAndSummaryTailStrategy(summaryTailStrategy);
    const historyReferenceStrategy = historyMemory.strategy;
    const nativeCompactionStrategy = model.contextCompactor !== undefined
      ? new ModelContextCompactionStrategy(model.contextCompactor)
      : undefined;
    const autoCompactionStrategies = options.autoCompactionStrategies ??
      automaticCompactionStrategies(
        autoMode,
        summaryTailStrategy,
        historyReferenceStrategy,
        nativeCompactionStrategy,
      );
    const contextBudget = withDefaultCompactionThreshold(
      options.contextBudget ?? contextBudgetFromModel(options.model),
    );

    const definition = defineAgent({
      ...(skills === undefined ? {} : { skills }),
      model,
      permissionPolicy: options.permissionPolicy ?? createCodingPermissionPolicy(),
      tools: configuredTools,
      toolScope: { workspaceId: resolve(options.workspace) },
      toolSource: () => [
        ...(options.toolSource?.() ?? []),
        ...(goals?.tools() ?? []),
        ...(delegation.host?.tools() ?? []),
      ],
      instructions: instructions.effective,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.agent.name": "maybecode",
        ...(options.modelInfo?.profile === undefined
          ? {}
          : { "may.model.profile": options.modelInfo.profile }),
        ...(options.modelInfo?.provider === undefined
          ? {}
          : { "may.model.provider": options.modelInfo.provider }),
        ...(options.modelInfo?.adapter === undefined
          ? {}
          : { "may.model.adapter": options.modelInfo.adapter }),
        ...(options.modelInfo?.model === undefined
          ? {}
          : { "may.model.name": options.modelInfo.model }),
      },
      contextFactory: withDelegationInstructions(
        historyMemory.wrap(goals?.wrapContextFactory(options.contextFactory ?? new InMemoryContextFactory()) ?? options.contextFactory ?? new InMemoryContextFactory()),
        () => delegation.host?.instructions() ?? "",
      ),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      ...(options.compactionStrategy === undefined
        ? {}
        : { compactionStrategy: options.compactionStrategy }),
      autoCompactionStrategies,
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
      metadata: { workspace },
      contextMetadata: { workspace },
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    });
    historyMemory.attach(application);
    const readSessionState = async (key: string): Promise<unknown> => {
      const saved = [...await application.history()].reverse()
        .find(event => event.type === "state.updated" && event.key === key);
      return saved?.type === "state.updated" ? saved.value : undefined;
    };
    if (goals) {
      // 目标状态先不挂接，等协作宿主就绪后再绑定，Goal 的 Run 同样作为一次请求执行。
    }
    let subagents: SubagentHost | undefined;
    if (subagentConfiguration !== undefined) {
      const configured: MaybeCodeSubagentOptions = options.subagents === false ? {} : options.subagents ?? {};
      const host = new SubagentHost({
        configuration: subagentConfiguration,
        workspace,
        dataDirectory: configured.dataDirectory ?? defaultSubagentDataDirectory(options.store),
        sessionId: application.sessionId,
        application,
        store: options.store,
        model: baseModel,
        ...(configured.createRoleModel === undefined ? {} : { createRoleModel: configured.createRoleModel }),
        ...(configured.contextBudgetFor === undefined ? {} : { contextBudgetFor: configured.contextBudgetFor }),
        instructions: instructions.effective,
        permissionPolicy: options.permissionPolicy ?? createCodingPermissionPolicy(),
        ...(skills === undefined ? {} : { skills }),
        ...(options.toolSource === undefined ? {} : { toolSource: options.toolSource }),
        ...(contextBudget === undefined ? {} : { contextBudget }),
        ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
        autoCompactionMode: autoMode,
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
        traceAttributes: { "may.agent.name": "maybecode" },
        fileGuard,
        loadRequests: async () => readRequestIndex(await readSessionState(REQUEST_STATE_KEY)),
        saveRequests: async (requests) => application.recordState(
          REQUEST_STATE_KEY,
          { version: 1, requests: requests.slice(0, 16) },
        ),
      });
      delegation.host = host;
      subagents = host;
      try {
        await host.initialize();
      } catch (error) {
        await application.close();
        throw error;
      }
    }

    const instance = new MaybeCodeApplication(
      workspace,
      application,
      instructions,
      manualCompactionStrategy,
      summaryTailStrategy,
      historyReferenceStrategy,
      nativeCompactionStrategy,
      historyMemory,
      options.modelInfo,
      goals,
      subagents,
    );
    if (goals) {
      try {
        await goals.attach(instance.goalAgent(), {
          read: async () => await readSessionState("may.goal") as never,
          write: state => application.recordState("may.goal", state),
        });
      } catch (error) { await instance.close(); throw error; }
    }
    return instance;
  }

  get isRunning(): boolean {
    return this.inputOperations > 0 || this.application.isRunning ||
      this.goals?.isRunning === true || this.subagents?.isRunning === true;
  }

  get instructions(): MaybeCodeInstructions {
    return { ...this.baseInstructions, effective: [
      this.baseInstructions.effective,
      this.application.skills?.instructions(),
      this.subagents?.instructions(),
    ].filter(Boolean).join("\n\n") };
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
      submit: (options) => owner.startRequest({
        mode: "submit",
        input: options.input,
        record: requestRecord(options.input),
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
        ...(options.shouldYield === undefined ? {} : { shouldYield: options.shouldYield }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, { ...options, input: options.input }),
      continue: (options) => owner.startRequest({
        mode: "continue",
        input: "",
        record: "Continue the active goal",
        ...(options.runBudget === undefined ? {} : { runBudget: options.runBudget }),
        ...(options.shouldYield === undefined ? {} : { shouldYield: options.shouldYield }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
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
  ): Promise<boolean> {
    const subagent = this.subagents?.resolveApproval(requestId, decision);
    return subagent === undefined
      ? this.application.resolveApproval(requestId, decision)
      : subagent.then(resolved => resolved || this.application.resolveApproval(requestId, decision));
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      try { await this.goals?.close(); }
      finally {
        try {
          await this.steeringCancellation;
          await this.subagents?.close();
          await this.application.close();
          await this.inputTail;
          await this.eventRelay;
          await this.subagentRelay;
        }
        finally { this.removeGoalListener?.(); this.eventQueue.close(); }
      }
    } finally { this.eventQueue.close(); }
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

/** 把实时协作部分追加到本 Session 的每个 Context 指令中。 */
function withDelegationInstructions(
  factory: ContextFactory,
  text: () => string,
): ContextFactory {
  return {
    create: (options) => {
      const source = () => [
        options.instructionsSource?.() ?? options.instructions,
        text(),
      ].filter(Boolean).join("\n\n");
      return factory.create({ ...options, instructions: source(), instructionsSource: source });
    },
  };
}

/** 请求的持久文本记录；原始输入仍然保存在 Session 中。 */
function requestRecord(input: string | UserMessage): string {
  const text = typeof input === "string"
    ? input
    : input.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return text.trim() === "" ? "Request without text content" : text;
}

function readRequestIndex(value: unknown): readonly MaybeCodeDelegationRequest[] {
  const record = value as { version?: unknown; requests?: unknown } | undefined;
  if (record?.version !== 1 || !Array.isArray(record.requests)) return [];
  return record.requests.filter((request): request is MaybeCodeDelegationRequest =>
    typeof request === "object" && request !== null &&
    typeof (request as MaybeCodeDelegationRequest).requestId === "string" &&
    typeof (request as MaybeCodeDelegationRequest).status === "string");
}

/** 主会话与子 Agent 共用的自动压缩链构造。 */
function automaticCompactionStrategies(
  mode: MaybeCodeAutoCompactionMode,
  summary: ContextCompactionStrategy,
  historyReference: ContextCompactionStrategy,
  native: ContextCompactionStrategy | undefined,
): readonly ContextCompactionStrategy[] {
  switch (mode) {
    case "prune-summary": return [new PruneOldToolResultsStrategy(), summary];
    case "history-reference": return [historyReference];
    case "provider-native": return [requireNativeCompaction(native)];
    default: throw new Error(`Unknown automatic compaction mode: ${String(mode)}`);
  }
}

class PruneAndSummaryTailStrategy implements ContextCompactionStrategy {
  readonly name = "prune+summary-tail";
  private readonly prune = new PruneOldToolResultsStrategy();

  constructor(private readonly summaryTail: ContextCompactionStrategy) {}

  async compact(
    snapshot: Readonly<ContextSnapshot>,
    options: ContextCompactionOptions = {},
  ): Promise<ContextCompactionOutput> {
    const messages = this.prune.compact(snapshot);
    return this.summaryTail.compact(
      { ...snapshot, messages: [...messages] },
      options,
    );
  }
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
