import {
  AsyncEventQueue,
  isStreamingMayEvent,
  type RunOptions,
} from "@may/core";
import type {
  ContextCompactionResult,
  ContextBudget,
  ContextInspection,
} from "@may/context";
import type { Model } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type { ModelCapabilities } from "@may/providers";

import {
  MaybeCodeApplication,
  type MaybeCodeApplicationOptions,
} from "./application.js";
import {
  latestSession,
  type SessionCatalog,
  type SessionSummary,
} from "./catalog.js";
import type {
  MaybeCodeEvent,
  MaybeCodeRun,
} from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";
import type {
  MaybeCodeCompactionSelection,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";

export interface MaybeCodeModelConfiguration {
  readonly model: Model;
  readonly modelInfo: MaybeCodeModelInfo;
  readonly contextBudget?: ContextBudget;
}

export interface MaybeCodeWorkspaceOptions extends Omit<
  MaybeCodeApplicationOptions,
  "sessionId" | "resume"
> {
  readonly catalog: SessionCatalog;
  readonly sessionId?: string;
  /** Resume the latest workspace session when no sessionId is given. Defaults to false. */
  readonly autoResume?: boolean;
  readonly modelProfiles?: readonly MaybeCodeModelProfile[];
  readonly createModelConfiguration?: (
    profile: string,
    runtimeOptions?: Readonly<Record<string, unknown>>,
  ) => MaybeCodeModelConfiguration | Promise<MaybeCodeModelConfiguration>;
  readonly resolveModelCapabilities?: (
    profile: string,
  ) => Promise<ModelCapabilities>;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
}

export class MaybeCodeWorkspace implements MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;
  readonly workspace: string;

  private options: Omit<
    MaybeCodeWorkspaceOptions,
    "sessionId" | "autoResume"
  >;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeEvent>({
    maxBufferedValues: 1024,
    isDroppable: (value) =>
      value.type === "run.event" && isStreamingMayEvent(value.event),
  });
  private application: MaybeCodeApplication;
  private eventRelay: Promise<void>;
  private sessionRecordTail: Promise<void> = Promise.resolve();
  private readonly modelOptionOverrides = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private closed = false;

  private constructor(
    options: Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume">,
    application: MaybeCodeApplication,
    resumed: boolean,
  ) {
    this.options = options;
    this.application = application;
    this.workspace = application.workspace;
    this.events = this.eventQueue;
    this.eventRelay = this.relayEvents(application);
    this.eventQueue.push({
      type: "session.changed",
      sessionId: application.sessionId,
      resumed,
    });
  }

  static async open(
    options: MaybeCodeWorkspaceOptions,
  ): Promise<MaybeCodeWorkspace> {
    const base = withoutSelection(options);
    let sessionId = options.sessionId;
    if (sessionId === undefined && options.autoResume === true) {
      sessionId = (await latestSession(options.catalog, options.workspace))?.id;
      if (
        sessionId !== undefined &&
        (await options.store.read(sessionId)).length === 0
      ) {
        sessionId = undefined;
      }
    }

    const resumed = sessionId !== undefined;
    const application = await MaybeCodeApplication.open({
      ...applicationOptions(base),
      ...(sessionId === undefined ? {} : { sessionId, resume: true }),
    });
    const manager = new MaybeCodeWorkspace(base, application, resumed);
    await manager.recordCurrentSession();
    return manager;
  }

  get sessionId(): string {
    return this.application.sessionId;
  }

  get isRunning(): boolean {
    return this.application.isRunning;
  }

  get instructions(): MaybeCodeInstructions {
    return this.application.instructions;
  }

  get modelInfo(): MaybeCodeModelInfo | undefined {
    return this.application.modelInfo;
  }

  async submit(options: RunOptions): Promise<MaybeCodeRun> {
    this.throwIfClosed();
    const run = await this.application.submit(options);
    await this.recordCurrentSession();
    return this.withSessionRecord(run);
  }

  async retry(): Promise<MaybeCodeRun> {
    this.throwIfClosed();
    await this.recordCurrentSession();
    return this.withSessionRecord(await this.application.retry());
  }

  cancel(reason?: string): boolean {
    return this.application.cancel(reason);
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    this.throwIfClosed();
    return this.application.resolveApproval(requestId, decision);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    this.throwIfClosed();
    return this.options.catalog.list(this.workspace);
  }

  async newSession(): Promise<string> {
    this.throwIfClosed();
    this.assertIdle();
    const next = await MaybeCodeApplication.open(applicationOptions(this.options));
    await this.replaceApplication(next, false);
    return next.sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.throwIfClosed();
    this.assertIdle();
    if (sessionId === this.sessionId) return;
    const next = await MaybeCodeApplication.open({
      ...applicationOptions(this.options),
      sessionId,
      resume: true,
    });
    await this.replaceApplication(next, true);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    this.throwIfClosed();
    this.assertIdle();
    const normalized = title.replace(/\s+/gu, " ").trim();
    if (normalized === "") throw new Error("Session title cannot be empty");
    const rename = this.options.catalog.rename;
    if (rename === undefined) {
      throw new Error("The active session catalog does not support renaming");
    }
    if (!await rename.call(
      this.options.catalog,
      sessionId,
      this.workspace,
      normalized,
    )) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.throwIfClosed();
    this.assertIdle();
    if (sessionId === this.sessionId) {
      throw new Error("Cannot delete the active session");
    }
    const removeHistory = this.options.store.delete;
    const removeCatalog = this.options.catalog.remove;
    if (removeHistory === undefined) {
      throw new Error("The active session store does not support deletion");
    }
    if (removeCatalog === undefined) {
      throw new Error("The active session catalog does not support deletion");
    }
    const known = (await this.options.catalog.list(this.workspace)).some(
      (session) => session.id === sessionId,
    );
    if (!known) return false;
    const historyRemoved = await removeHistory.call(this.options.store, sessionId);
    const catalogRemoved = await removeCatalog.call(
      this.options.catalog,
      sessionId,
      this.workspace,
    );
    return historyRemoved || catalogRemoved;
  }

  async listModels(): Promise<readonly MaybeCodeModelProfile[]> {
    this.throwIfClosed();
    return [...(this.options.modelProfiles ?? [])];
  }

  async switchModel(profile: string): Promise<MaybeCodeModelInfo> {
    this.throwIfClosed();
    this.assertIdle();
    const selected = (this.options.modelProfiles ?? []).find((candidate) =>
      candidate.name === profile
    );
    if (selected === undefined) {
      throw new Error(`Unknown model profile "${profile}"`);
    }
    if (this.modelInfo?.profile === profile) {
      this.eventQueue.push({ type: "model.changed", model: this.modelInfo });
      return this.modelInfo;
    }
    const create = this.options.createModelConfiguration;
    if (create === undefined) {
      throw new Error("The active MaybeCode workspace cannot switch models");
    }

    await this.recordCurrentSession();
    const configuration = await create(
      profile,
      this.modelOptionOverrides.get(profile),
    );
    if (configuration.modelInfo.profile !== profile) {
      throw new Error(
        `Model configuration for "${profile}" returned profile ` +
          `"${configuration.modelInfo.profile ?? "unknown"}"`,
      );
    }
    const nextOptions = withModelConfiguration(this.options, configuration);
    const next = await MaybeCodeApplication.open({
      ...applicationOptions(nextOptions),
      sessionId: this.sessionId,
      resume: true,
    });
    this.options = nextOptions;
    await this.replaceApplication(next);
    this.eventQueue.push({ type: "model.changed", model: configuration.modelInfo });
    return configuration.modelInfo;
  }

  async setDefaultModel(profile: string): Promise<void> {
    this.throwIfClosed();
    const profiles = this.options.modelProfiles ?? [];
    if (!profiles.some((candidate) => candidate.name === profile)) {
      throw new Error(`Unknown model profile "${profile}"`);
    }
    const persist = this.options.persistDefaultModel;
    if (persist === undefined) {
      throw new Error("The active MaybeCode configuration is not writable");
    }

    await persist(profile);
    this.options = {
      ...this.options,
      modelProfiles: profiles.map((candidate) => ({
        ...candidate,
        isDefault: candidate.name === profile,
      })),
    };
    this.eventQueue.push({ type: "model.default.changed", profile });
  }

  async getReasoningEffort(): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    const profile = this.modelInfo?.profile;
    if (profile === undefined) return unknownReasoningEffort();
    const resolveCapabilities = this.options.resolveModelCapabilities;
    if (resolveCapabilities === undefined) return unknownReasoningEffort();

    const capabilities = (await resolveCapabilities(profile)).reasoningEffort;
    const configured = (this.options.modelProfiles ?? []).find((candidate) =>
      candidate.name === profile
    )?.reasoningEffort;
    const override = this.modelOptionOverrides.get(profile)?.reasoningEffort;
    const overridden = typeof override === "string";
    const effectiveEffort = overridden
      ? override
      : configured ?? (
        capabilities.status === "known"
          ? capabilities.defaultEffort
          : undefined
      );
    return {
      status: capabilities.status,
      source: capabilities.source,
      efforts: capabilities.status === "known"
        ? [...capabilities.efforts]
        : [],
      ...(capabilities.status === "known" &&
          capabilities.defaultEffort !== undefined
        ? { defaultEffort: capabilities.defaultEffort }
        : {}),
      ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
      overridden,
    };
  }

  async setReasoningEffort(
    effort?: string,
  ): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    this.assertIdle();
    const profile = this.modelInfo?.profile;
    if (profile === undefined) {
      throw new Error("The active model has no configurable profile");
    }
    const state = await this.getReasoningEffort();
    if (effort !== undefined) {
      if (state.status === "unknown") {
        throw new Error(
          `Reasoning effort capabilities are unknown for model profile "${profile}"`,
        );
      }
      if (state.status === "unsupported") {
        throw new Error(
          `Model profile "${profile}" does not support effort-based reasoning`,
        );
      }
      if (!state.efforts.includes(effort)) {
        throw new Error(
          `Reasoning effort "${effort}" is unsupported by model profile ` +
            `"${profile}"; supported values: ${state.efforts.join(", ")}`,
        );
      }
      this.modelOptionOverrides.set(profile, { reasoningEffort: effort });
    } else {
      this.modelOptionOverrides.delete(profile);
    }

    const create = this.options.createModelConfiguration;
    if (create === undefined) {
      throw new Error("The active MaybeCode workspace cannot tune models");
    }
    await this.recordCurrentSession();
    const configuration = await create(
      profile,
      this.modelOptionOverrides.get(profile),
    );
    const nextOptions = withModelConfiguration(this.options, configuration);
    const next = await MaybeCodeApplication.open({
      ...applicationOptions(nextOptions),
      sessionId: this.sessionId,
      resume: true,
    });
    this.options = nextOptions;
    await this.replaceApplication(next);
    return this.getReasoningEffort();
  }

  history() {
    return this.application.history();
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.application.inspectContext();
  }

  async compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    this.throwIfClosed();
    this.assertIdle();
    return this.application.compactContext(strategy);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.application.close();
    await this.eventRelay;
    await this.sessionRecordTail;
    this.eventQueue.close();
  }

  private async replaceApplication(
    next: MaybeCodeApplication,
    resumed?: boolean,
  ): Promise<void> {
    try {
      await this.application.close();
      await this.eventRelay;
    } catch (error) {
      await next.close();
      throw error;
    }

    this.application = next;
    this.eventRelay = this.relayEvents(next);
    await this.recordCurrentSession();
    if (resumed !== undefined) {
      this.eventQueue.push({
        type: "session.changed",
        sessionId: next.sessionId,
        resumed,
      });
    }
  }

  private async recordCurrentSession(): Promise<void> {
    const application = this.application;
    const operation = this.sessionRecordTail.then(async () => {
      const history = await application.history();
      const createdAt = history[0]?.timestamp ?? Date.now();
      const details = summarizeSession(history);
      await this.options.catalog.record({
        id: application.sessionId,
        workspace: this.workspace,
        createdAt,
        lastUsedAt: Date.now(),
        ...details,
      });
    });
    this.sessionRecordTail = operation.catch(() => undefined);
    return operation;
  }

  private withSessionRecord(run: MaybeCodeRun): MaybeCodeRun {
    const result = run.result.then(
      async (value) => {
        await this.recordCurrentSession();
        return value;
      },
      async (error: unknown) => {
        await this.recordCurrentSession();
        throw error;
      },
    );
    void result.catch(() => undefined);
    return { id: run.id, result, cancel: run.cancel };
  }

  private async relayEvents(application: MaybeCodeApplication): Promise<void> {
    for await (const event of application.events) {
      this.eventQueue.push(event);
    }
  }

  private assertIdle(): void {
    if (this.isRunning) {
      throw new Error("Cannot switch sessions while an operation is active");
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
}

function summarizeSession(
  history: readonly import("@may/session").SessionEvent[],
): Pick<SessionSummary, "title" | "preview" | "turnCount"> {
  const messages = history.flatMap((event) => {
    if (event.type === "input.submitted" || event.type === "assistant.completed") {
      const text = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .replace(/\s+/gu, " ")
        .trim();
      return text === "" ? [] : [text];
    }
    return [];
  });
  const firstInput = history.find((event) => event.type === "input.submitted");
  const title = firstInput?.type === "input.submitted"
    ? firstInput.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .replace(/\s+/gu, " ")
      .trim()
    : "";
  const preview = messages.at(-1);
  const turnCount = history.filter((event) =>
    event.type === "input.submitted"
  ).length;
  return {
    ...(title === "" ? {} : { title: truncate(title, 80) }),
    ...(preview === undefined ? {} : { preview: truncate(preview, 180) }),
    turnCount,
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function withoutSelection(
  options: MaybeCodeWorkspaceOptions,
): Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume"> {
  const { sessionId: _sessionId, autoResume: _autoResume, ...base } = options;
  return base;
}

function applicationOptions(
  options: Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume">,
): MaybeCodeApplicationOptions {
  const {
    catalog: _catalog,
    modelProfiles: _modelProfiles,
    createModelConfiguration: _createModelConfiguration,
    resolveModelCapabilities: _resolveModelCapabilities,
    persistDefaultModel: _persistDefaultModel,
    ...application
  } = options;
  return application;
}

function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

function withModelConfiguration(
  options: Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume">,
  configuration: MaybeCodeModelConfiguration,
): Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume"> {
  const {
    model: _model,
    modelInfo: _modelInfo,
    contextBudget: _contextBudget,
    ...unchanged
  } = options;
  return {
    ...unchanged,
    model: configuration.model,
    modelInfo: configuration.modelInfo,
    ...(configuration.contextBudget === undefined
      ? {}
      : { contextBudget: configuration.contextBudget }),
  };
}
