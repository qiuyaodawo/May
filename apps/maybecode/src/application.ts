import { resolve } from "node:path";

import {
  AgentApplication,
  contextBudgetFromModel,
  withDefaultCompactionThreshold,
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
  HistoryReferenceStrategy,
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
  type ContextSnapshot,
  type Model,
  type RunOptions,
  type Tool,
} from "@may/core";
import type { ApprovalDecision, PermissionPolicy } from "@may/permissions";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionStore,
} from "@may/session";

import type {
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

export { DEFAULT_MAYBE_CODE_INSTRUCTIONS } from "./instructions.js";

export interface MaybeCodeApplicationOptions {
  readonly workspace: string;
  readonly model: Model;
  readonly modelInfo?: MaybeCodeModelInfo;
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly tools?: readonly Tool[];
  readonly permissionPolicy?: PermissionPolicy;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Include the model's native compactor in the default automatic chain. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  readonly maxSteps?: number;
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
  readonly instructions: MaybeCodeInstructions;
  readonly modelInfo: MaybeCodeModelInfo | undefined;

  private readonly application: AgentApplication;
  private readonly manualCompactionStrategy: ContextCompactionStrategy;
  private readonly summaryTailStrategy: ContextCompactionStrategy;
  private readonly historyReferenceStrategy: ContextCompactionStrategy;
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
    modelInfo: MaybeCodeModelInfo | undefined,
  ) {
    this.workspace = workspace;
    this.application = application;
    this.sessionId = application.sessionId;
    this.instructions = instructions;
    this.manualCompactionStrategy = manualCompactionStrategy;
    this.summaryTailStrategy = summaryTailStrategy;
    this.historyReferenceStrategy = historyReferenceStrategy;
    this.modelInfo = modelInfo === undefined ? undefined : { ...modelInfo };
    this.events = this.eventQueue;
    this.eventRelay = this.relayEvents(application.events);
  }

  static async open(
    options: MaybeCodeApplicationOptions,
  ): Promise<MaybeCodeApplication> {
    const workspace = resolve(options.workspace);
    const configuredTools = options.tools ?? createCodingTools({ cwd: workspace });
    const shellInfo = configuredTools
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
    const historyReferenceStrategy = new HistoryReferenceStrategy({
      reference:
        "Earlier model-visible context was removed to recover context capacity. " +
        "The complete durable history remains available through the " +
        "session_history tool. Inspect it when details from earlier work are " +
        "needed, then continue the current request.",
    });
    const nativeCompactionStrategy =
      options.providerNativeAutoCompaction === true &&
        options.model.contextCompactor !== undefined
        ? new ModelContextCompactionStrategy(options.model.contextCompactor)
        : undefined;
    const autoCompactionStrategies = options.autoCompactionStrategies ?? [
      new PruneOldToolResultsStrategy(),
      ...(nativeCompactionStrategy === undefined
        ? []
        : [nativeCompactionStrategy]),
      summaryTailStrategy,
      historyReferenceStrategy,
    ];
    const contextBudget = withDefaultCompactionThreshold(
      options.contextBudget ?? contextBudgetFromModel(options.model),
    );

    const application = await AgentApplication.open({
      model: options.model,
      store: options.store,
      permissionPolicy: options.permissionPolicy ?? createCodingPermissionPolicy(),
      tools: configuredTools,
      instructions: instructions.effective,
      metadata: { workspace },
      contextMetadata: { workspace },
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.contextFactory === undefined
        ? {}
        : { contextFactory: options.contextFactory }),
      ...(contextBudget === undefined ? {} : { contextBudget }),
      ...(options.compactionStrategy === undefined
        ? {}
        : { compactionStrategy: options.compactionStrategy }),
      autoCompactionStrategies,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      sessionHistory: {},
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

    return new MaybeCodeApplication(
      workspace,
      application,
      instructions,
      manualCompactionStrategy,
      summaryTailStrategy,
      historyReferenceStrategy,
      options.modelInfo,
    );
  }

  get isRunning(): boolean {
    return this.application.isRunning;
  }

  submit(options: RunOptions): Promise<MaybeCodeRun> {
    return this.application.submit(options);
  }

  retry(): Promise<MaybeCodeRun> {
    return this.application.retry();
  }

  cancel(reason?: string): boolean {
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
    if (typeof selection === "object") return selection;
    throw new Error(`Unknown context compaction strategy: ${String(selection)}`);
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
