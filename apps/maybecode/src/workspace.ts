import { resolve } from "node:path";

import { AgentWorkspace } from "@may/application";
import type {
  ContextBudget,
  ContextCompactionResult,
  ContextInspection,
} from "@may/context";
import type { Model, RunOptions } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type { ModelCapabilities } from "@may/providers";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
} from "@may/session";
import type { SessionCatalog, SessionSummary } from "@may/session/catalog";

import {
  MaybeCodeApplication,
  type MaybeCodeApplicationOptions,
} from "./application.js";
import type {
  MaybeCodeCompactionSelection,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type {
  MaybeCodeEvent,
  MaybeCodeRun,
  MaybeCodeSessionEvent,
} from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

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

type MaybeCodeProductEvent = Exclude<MaybeCodeEvent, MaybeCodeSessionEvent | {
  type: "session.changed";
  sessionId: string;
  resumed: boolean;
}>;

type ActiveWorkspaceOptions = Omit<
  MaybeCodeWorkspaceOptions,
  "sessionId" | "autoResume"
>;

interface WorkspaceState {
  options: ActiveWorkspaceOptions;
}

type BaseWorkspace = AgentWorkspace<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection,
  MaybeCodeApplication
>;

/** MaybeCode model policy around the reusable multi-session workspace. */
export class MaybeCodeWorkspace implements MaybeCodeController {
  readonly events: AsyncIterable<MaybeCodeEvent>;
  readonly workspace: string;

  private readonly manager: BaseWorkspace;
  private readonly state: WorkspaceState;
  private readonly modelOptionOverrides = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  private closed = false;

  private constructor(state: WorkspaceState, manager: BaseWorkspace) {
    this.state = state;
    this.manager = manager;
    this.workspace = manager.workspace;
    this.events = manager.events;
  }

  static async open(
    options: MaybeCodeWorkspaceOptions,
  ): Promise<MaybeCodeWorkspace> {
    const state: WorkspaceState = {
      options: withoutSelection({
        ...options,
        workspace: resolve(options.workspace),
      }),
    };
    const manager = await AgentWorkspace.open<
      MaybeCodeSessionEvent,
      MaybeCodeProductEvent,
      MaybeCodeCompactionSelection,
      MaybeCodeApplication
    >({
      workspace: state.options.workspace,
      store: state.options.store,
      catalog: state.options.catalog,
      openApplication: (selection) => MaybeCodeApplication.open({
        ...applicationOptions(state.options),
        ...(selection.sessionId === undefined
          ? {}
          : { sessionId: selection.sessionId }),
        resume: selection.resume,
      }),
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.autoResume === undefined
        ? {}
        : { autoResume: options.autoResume }),
    });
    return new MaybeCodeWorkspace(state, manager);
  }

  get sessionId(): string {
    return this.manager.sessionId;
  }

  get isRunning(): boolean {
    return this.manager.isRunning;
  }

  get instructions(): MaybeCodeInstructions {
    return this.manager.activeApplication.instructions;
  }

  get modelInfo(): MaybeCodeModelInfo | undefined {
    return this.manager.activeApplication.modelInfo;
  }

  submit(options: RunOptions): Promise<MaybeCodeRun> {
    return this.manager.submit(options);
  }

  retry(): Promise<MaybeCodeRun> {
    return this.manager.retry();
  }

  cancel(reason?: string): boolean {
    return this.manager.cancel(reason);
  }

  resolveApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    return this.manager.resolveApproval(requestId, decision);
  }

  listSessions(): Promise<readonly SessionSummary[]> {
    return this.manager.listSessions();
  }

  newSession(): Promise<string> {
    return this.manager.newSession();
  }

  resumeSession(sessionId: string): Promise<void> {
    return this.manager.resumeSession(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.manager.renameSession(sessionId, title);
  }

  deleteSession(sessionId: string): Promise<boolean> {
    return this.manager.deleteSession(sessionId);
  }

  async listModels(): Promise<readonly MaybeCodeModelProfile[]> {
    this.throwIfClosed();
    return [...(this.state.options.modelProfiles ?? [])];
  }

  async switchModel(profile: string): Promise<MaybeCodeModelInfo> {
    this.throwIfClosed();
    const selected = (this.state.options.modelProfiles ?? []).find((candidate) =>
      candidate.name === profile
    );
    if (selected === undefined) throw new Error(`Unknown model profile "${profile}"`);

    if (this.modelInfo?.profile === profile) {
      return this.manager.runStateTransition((application) => {
        const model = application.modelInfo;
        if (model === undefined) {
          throw new Error("The active application does not expose model information");
        }
        this.manager.emit({ type: "model.changed", model });
        return model;
      }, {
        activeOperationMessage:
          "Cannot switch sessions while an operation is active",
      });
    }

    let result: MaybeCodeModelInfo | undefined;
    await this.manager.transitionApplication(async (current) => {
      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot switch models");
      }
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
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
      );
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      result = configuration.modelInfo;
      return next;
    }, {
      createEvent: (application) => ({
        type: "model.changed",
        model: application.modelInfo!,
      }),
    });
    return result!;
  }

  setDefaultModel(profile: string): Promise<void> {
    this.throwIfClosed();
    return this.manager.runStateTransition(async () => {
      const profiles = this.state.options.modelProfiles ?? [];
      if (!profiles.some((candidate) => candidate.name === profile)) {
        throw new Error(`Unknown model profile "${profile}"`);
      }
      const persist = this.state.options.persistDefaultModel;
      if (persist === undefined) {
        throw new Error("The active MaybeCode configuration is not writable");
      }

      await persist(profile);
      this.state.options = {
        ...this.state.options,
        modelProfiles: profiles.map((candidate) => ({
          ...candidate,
          isDefault: candidate.name === profile,
        })),
      };
      this.manager.emit({ type: "model.default.changed", profile });
    }, { requireIdle: false });
  }

  async getReasoningEffort(): Promise<MaybeCodeReasoningEffortState> {
    this.throwIfClosed();
    const profile = this.modelInfo?.profile;
    if (profile === undefined) return unknownReasoningEffort();
    const resolveCapabilities = this.state.options.resolveModelCapabilities;
    if (resolveCapabilities === undefined) return unknownReasoningEffort();

    const capabilities = (await resolveCapabilities(profile)).reasoningEffort;
    const configured = (this.state.options.modelProfiles ?? []).find(
      (candidate) => candidate.name === profile,
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
    await this.manager.transitionApplication(async (current) => {
      const profile = current.modelInfo?.profile;
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

      const create = this.state.options.createModelConfiguration;
      if (create === undefined) {
        throw new Error("The active MaybeCode workspace cannot tune models");
      }
      const configuration = await create(
        profile,
        this.modelOptionOverrides.get(profile),
      );
      const nextOptions = withModelConfiguration(
        this.state.options,
        configuration,
      );
      const next = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions),
        sessionId: current.sessionId,
        resume: true,
      });
      this.state.options = nextOptions;
      return next;
    });
    return this.getReasoningEffort();
  }

  history() {
    return this.manager.history();
  }

  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.manager.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    return this.manager.inspectContext();
  }

  compactContext(
    strategy?: MaybeCodeCompactionSelection,
  ): Promise<ContextCompactionResult> {
    return this.manager.compactContext(strategy);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.manager.close();
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
}

function withoutSelection(
  options: MaybeCodeWorkspaceOptions,
): ActiveWorkspaceOptions {
  const { sessionId: _sessionId, autoResume: _autoResume, ...base } = options;
  return base;
}

function applicationOptions(
  options: ActiveWorkspaceOptions,
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
  options: ActiveWorkspaceOptions,
  configuration: MaybeCodeModelConfiguration,
): ActiveWorkspaceOptions {
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
