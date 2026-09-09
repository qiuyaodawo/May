import { resolve } from "node:path";
import { SkillRegistry } from "@may/skills";
import { defaultMaybeCodeSkillDirectories } from "./skills.js";

import {
  contextBudgetFromModel,
  defineAgent,
  withDefaultCompactionThreshold,
  type AgentApplication,
  type AgentApplicationEvent,
} from "@may/application";
import {
  createCodingTools,
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
  isStreamingMayEvent,
  ToolRegistry,
  type ContextSnapshot,
  type Model,
  type RunOptions,
  type RunBudget,
  type Tool,
  type TraceAttributes,
  type Tracer,
} from "@may/core";
import type { ApprovalDecision, PermissionPolicy } from "@may/permissions";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionStore,
} from "@may/session";

import type {
  MaybeCodeAutoCompactionMode,
  MaybeCodeCompactionSelection,
  MaybeCodeModelInfo,
} from "./controller.js";
import type { MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import {
  loadMaybeCodeInstructions,
  type MaybeCodeInstructions,
} from "./instructions.js";
import { createCodingPermissionPolicy } from "./policy.js";
import { createModelContextSummarizer } from "./summarizer.js";
import { HistoryReferenceMemory } from "./history-memory.js";

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";

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
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly skillDirectories?: readonly string[];
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
  private closed = false;

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
    this.events = this.eventQueue;
    this.eventRelay = this.relayEvents(application.events);
  }

  static async open(
    options: MaybeCodeApplicationOptions,
  ): Promise<MaybeCodeApplication> {
    const workspace = resolve(options.workspace);
    const autoMode = options.autoCompactionMode ??
      (options.providerNativeAutoCompaction === true ? "provider-native" : "prune-summary");
    const historyMemory = new HistoryReferenceMemory(
      autoMode === "history-reference" && options.autoCompactionStrategies === undefined,
    );
    const skills = options.skills === false ? undefined : options.skills ??
      await SkillRegistry.discover(options.skillDirectories ?? defaultMaybeCodeSkillDirectories(workspace, false));
    const configuredTools = ToolRegistry.compose(
      options.tools ?? createCodingTools({ cwd: workspace }),
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
        createModelContextSummarizer(options.model),
    });
    const manualCompactionStrategy = options.compactionStrategy ??
      new PruneAndSummaryTailStrategy(summaryTailStrategy);
    const historyReferenceStrategy = historyMemory.strategy;
    const nativeCompactionStrategy = options.model.contextCompactor !== undefined
      ? new ModelContextCompactionStrategy(options.model.contextCompactor)
      : undefined;
    const autoCompactionStrategies = options.autoCompactionStrategies ??
      automaticStrategies(
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
      model: options.model,
      permissionPolicy: options.permissionPolicy ?? createCodingPermissionPolicy(),
      tools: configuredTools,
      toolScope: { workspaceId: resolve(options.workspace) },
      ...(options.toolSource === undefined ? {} : { toolSource: options.toolSource }),
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
      contextFactory: historyMemory.wrap(options.contextFactory ?? new InMemoryContextFactory()),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      ...(options.compactionStrategy === undefined
        ? {}
        : { compactionStrategy: options.compactionStrategy }),
      autoCompactionStrategies,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
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

    return new MaybeCodeApplication(
      workspace,
      application,
      instructions,
      manualCompactionStrategy,
      summaryTailStrategy,
      historyReferenceStrategy,
      nativeCompactionStrategy,
      historyMemory,
      options.modelInfo,
    );
  }

  get isRunning(): boolean {
    return this.application.isRunning;
  }

  get instructions(): MaybeCodeInstructions {
    return { ...this.baseInstructions, effective: [this.baseInstructions.effective, this.application.skills?.instructions()].filter(Boolean).join("\n\n") };
  }

  submit(options: RunOptions): Promise<MaybeCodeRun> {
    return this.application.submit(options);
  }

  retry(): Promise<MaybeCodeRun> {
    return this.application.retry();
  }

  cancel(reason?: string): boolean {
    this.historyMemory.cancelRequest();
    return this.application.cancel(reason);
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    return this.application.resolveApproval(requestId, decision);
  }

  history() {
    return this.application.history();
  }

  listRecoveries() { return this.application.listRecoveries(); }
  get skills() { return this.application.skills; }
  activateSkill(name: string) { return this.application.activateSkill(name); }
  resolveRecovery(id: string, finding: string) { return this.application.resolveRecovery(id, finding); }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.application.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.application.inspectContext();
  }

  compactContext(
    selection?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    return this.application.compactContext(
      this.resolveCompactionStrategy(selection),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.application.close();
    await this.eventRelay;
    this.eventQueue.close();
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

function automaticStrategies(
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
