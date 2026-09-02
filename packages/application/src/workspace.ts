import type {
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextInspection,
} from "@may/context";
import {
  AsyncEventQueue,
  isStreamingMayEvent,
  type RunOptions,
} from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type {
  SessionEvent,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionStore,
} from "@may/session";
import {
  latestSession,
  type SessionCatalog,
  type SessionSummary,
} from "@may/session/catalog";

import type {
  AgentController,
  AgentWorkspaceController,
} from "./controller.js";
import type {
  AgentApplicationEvent,
  AgentRun,
  AgentWorkspaceEvent,
} from "./events.js";
import { AsyncStateSerializer } from "./state-serializer.js";

export interface AgentApplicationSelection {
  readonly sessionId?: string;
  readonly resume: boolean;
}

export type SessionSummaryFactory = (
  history: readonly SessionEvent[],
) => Pick<SessionSummary, "title" | "preview" | "turnCount">;

export interface AgentWorkspaceOptions<
  ApplicationEvent = AgentApplicationEvent,
  CompactionSelection = ContextCompactionStrategy,
  Application extends AgentController<
    ApplicationEvent,
    CompactionSelection
  > = AgentController<ApplicationEvent, CompactionSelection>,
> {
  readonly workspace: string;
  readonly store: SessionStore;
  readonly catalog: SessionCatalog;
  readonly openApplication: (
    selection: AgentApplicationSelection,
  ) => Application | Promise<Application>;
  readonly sessionId?: string;
  /** Resume the latest non-empty workspace session when no id is given. */
  readonly autoResume?: boolean;
  readonly summarizeSession?: SessionSummaryFactory;
  readonly now?: () => number;
  readonly isDroppableEvent?: (
    event: AgentWorkspaceEvent<ApplicationEvent, unknown>,
  ) => boolean;
}

export interface AgentApplicationTransitionOptions<
  Application,
  ExtensionEvent,
> {
  /** Defaults to true; model/config transitions should preserve the session. */
  readonly preserveSession?: boolean;
  readonly event?: ExtensionEvent;
  readonly createEvent?: (application: Application) => ExtensionEvent;
}

export interface AgentStateTransitionOptions {
  /** Defaults to true. Set false for state that cannot affect an active run. */
  readonly requireIdle?: boolean;
  readonly activeOperationMessage?: string;
}

/**
 * Multi-session lifecycle shared by headless Agent applications.
 *
 * Model/profile state remains product-owned. `transitionApplication` provides
 * the same serialized, idle-only replacement primitive used by session changes
 * so a product can rebuild an application after changing model configuration.
 */
export class AgentWorkspace<
  ApplicationEvent = AgentApplicationEvent,
  ExtensionEvent = never,
  CompactionSelection = ContextCompactionStrategy,
  Application extends AgentController<
    ApplicationEvent,
    CompactionSelection
  > = AgentController<ApplicationEvent, CompactionSelection>,
> implements AgentWorkspaceController<
    ApplicationEvent,
    ExtensionEvent,
    CompactionSelection
  > {
  readonly events: AsyncIterable<
    AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>
  >;
  readonly workspace: string;

  private readonly store: SessionStore;
  private readonly catalog: SessionCatalog;
  private readonly openApplication: AgentWorkspaceOptions<
    ApplicationEvent,
    CompactionSelection,
    Application
  >["openApplication"];
  private readonly summarizeSession: SessionSummaryFactory;
  private readonly now: () => number;
  private readonly eventQueue: AsyncEventQueue<
    AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>
  >;
  private readonly state = new AsyncStateSerializer();
  private application: Application;
  private eventRelay: Promise<void>;
  private sessionRecordTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    options: AgentWorkspaceOptions<
      ApplicationEvent,
      CompactionSelection,
      Application
    >,
    application: Application,
    resumed: boolean,
  ) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.openApplication = options.openApplication;
    this.summarizeSession = options.summarizeSession ?? summarizeSessionHistory;
    this.now = options.now ?? Date.now;
    this.workspace = options.workspace;
    this.eventQueue = new AsyncEventQueue({
      maxBufferedValues: 1024,
      isDroppable: (value) => isDroppableWorkspaceEvent(
        value,
        options.isDroppableEvent,
      ),
    });
    this.events = this.eventQueue;
    this.application = application;
    this.eventRelay = this.relayEvents(application);
    this.eventQueue.push({
      type: "session.changed",
      sessionId: application.sessionId,
      resumed,
    });
  }

  static async open<
    ApplicationEvent = AgentApplicationEvent,
    ExtensionEvent = never,
    CompactionSelection = ContextCompactionStrategy,
    Application extends AgentController<
      ApplicationEvent,
      CompactionSelection
    > = AgentController<ApplicationEvent, CompactionSelection>,
  >(
    options: AgentWorkspaceOptions<
      ApplicationEvent,
      CompactionSelection,
      Application
    >,
  ): Promise<AgentWorkspace<
    ApplicationEvent,
    ExtensionEvent,
    CompactionSelection,
    Application
  >> {
    let sessionId = options.sessionId;
    if (sessionId === undefined && options.autoResume === true) {
      sessionId = (await latestSession(options.catalog, options.workspace))?.id;
      if (sessionId !== undefined && (await options.store.read(sessionId)).length === 0) {
        sessionId = undefined;
      }
    }

    const resumed = sessionId !== undefined;
    const application = await options.openApplication({
      ...(sessionId === undefined ? {} : { sessionId }),
      resume: resumed,
    });
    if (sessionId !== undefined && application.sessionId !== sessionId) {
      await application.close();
      throw new Error(
        `Application resumed unexpected session "${application.sessionId}"; expected "${sessionId}"`,
      );
    }
    const workspace = new AgentWorkspace(options, application, resumed);
    await workspace.recordCurrentSession().catch(() => undefined);
    return workspace;
  }

  get sessionId(): string {
    return this.application.sessionId;
  }

  get isRunning(): boolean {
    return this.application.isRunning;
  }

  /** Product wrappers may read application-owned metadata such as model info. */
  get activeApplication(): Application {
    return this.application;
  }

  async submit(options: RunOptions): Promise<AgentRun> {
    return this.state.run(async () => {
      const run = await this.application.submit(options);
      void this.recordCurrentSession().catch(() => undefined);
      return this.withSessionRecord(run);
    });
  }

  async retry(): Promise<AgentRun> {
    return this.state.run(async () => {
      void this.recordCurrentSession().catch(() => undefined);
      return this.withSessionRecord(await this.application.retry());
    });
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
    return this.catalog.list(this.workspace);
  }

  async newSession(): Promise<string> {
    return this.state.run(async () => {
      this.assertIdle("Cannot switch sessions while an operation is active");
      const next = await this.openApplication({ resume: false });
      await this.replaceApplication(next, false);
      return next.sessionId;
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    return this.state.run(async () => {
      this.assertIdle("Cannot switch sessions while an operation is active");
      if (sessionId === this.sessionId) return;
      const next = await this.openApplication({ sessionId, resume: true });
      if (next.sessionId !== sessionId) {
        await next.close();
        throw new Error(
          `Application resumed unexpected session "${next.sessionId}"; expected "${sessionId}"`,
        );
      }
      await this.replaceApplication(next, true);
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    return this.state.run(async () => {
      this.assertIdle("Cannot rename sessions while an operation is active");
      const normalized = title.replace(/\s+/gu, " ").trim();
      if (normalized === "") throw new Error("Session title cannot be empty");
      const rename = this.catalog.rename;
      if (rename === undefined) {
        throw new Error("The active session catalog does not support renaming");
      }
      if (!await rename.call(this.catalog, sessionId, this.workspace, normalized)) {
        throw new Error(`Session "${sessionId}" does not exist`);
      }
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.state.run(async () => {
      this.assertIdle("Cannot delete sessions while an operation is active");
      if (sessionId === this.sessionId) {
        throw new Error("Cannot delete the active session");
      }
      const removeHistory = this.store.delete;
      const removeCatalog = this.catalog.remove;
      if (removeHistory === undefined) {
        throw new Error("The active session store does not support deletion");
      }
      if (removeCatalog === undefined) {
        throw new Error("The active session catalog does not support deletion");
      }
      const known = (await this.catalog.list(this.workspace)).some(
        (session) => session.id === sessionId,
      );
      if (!known) return false;
      const historyRemoved = await removeHistory.call(this.store, sessionId);
      const catalogRemoved = await removeCatalog.call(
        this.catalog,
        sessionId,
        this.workspace,
      );
      return historyRemoved || catalogRemoved;
    });
  }

  history(): Promise<readonly SessionEvent[]> {
    this.throwIfClosed();
    return this.application.history();
  }

  queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
    this.throwIfClosed();
    return this.application.queryHistory(query);
  }

  inspectContext(): Promise<ContextInspection | undefined> {
    this.throwIfClosed();
    return this.application.inspectContext();
  }

  compactContext(
    selection?: CompactionSelection,
  ): Promise<ContextCompactionResult> {
    return this.state.run(async () => {
      this.assertIdle("Cannot compact context while an operation is active");
      return this.application.compactContext(selection);
    });
  }

  /**
   * Run product-owned state work on the same queue as session operations.
   * The callback must not call another serialized AgentWorkspace method.
   */
  runStateTransition<T>(
    operation: (application: Application) => T | Promise<T>,
    options: AgentStateTransitionOptions = {},
  ): Promise<T> {
    this.throwIfClosed();
    return this.state.run(async () => {
      if (options.requireIdle !== false) {
        this.assertIdle(
          options.activeOperationMessage ??
            "Cannot change application state while an operation is active",
        );
      }
      return operation(this.application);
    });
  }

  /**
   * Atomically replace the active application for a product-owned transition,
   * such as switching a model profile. Creation happens before the old instance
   * is closed; failure leaves the old application active.
   */
  transitionApplication(
    create: (current: Application) => Application | Promise<Application>,
    options: AgentApplicationTransitionOptions<Application, ExtensionEvent> = {},
  ): Promise<Application> {
    this.throwIfClosed();
    return this.state.run(async () => {
      this.assertIdle("Cannot replace the application while an operation is active");
      await this.recordCurrentSession().catch(() => undefined);
      const previous = this.application;
      const next = await create(previous);
      if (next === previous) {
        throw new Error("Application transition must return a new instance");
      }
      if (
        options.preserveSession !== false &&
        next.sessionId !== previous.sessionId
      ) {
        await next.close();
        throw new Error(
          `Application transition changed session from "${previous.sessionId}" ` +
            `to "${next.sessionId}"`,
        );
      }
      await this.replaceApplication(next);
      const event = options.createEvent?.(next) ?? options.event;
      if (event !== undefined) this.eventQueue.push(event);
      return next;
    });
  }

  /** Emit a product event through the ordered workspace event channel. */
  emit(event: ExtensionEvent): void {
    this.throwIfClosed();
    this.eventQueue.push(event);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.state.close();
    await this.application.close();
    await this.eventRelay;
    await this.sessionRecordTail;
    this.eventQueue.close();
  }

  private async replaceApplication(
    next: Application,
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
    await this.recordCurrentSession().catch(() => undefined);
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
      const createdAt = history[0]?.timestamp ?? this.now();
      await this.catalog.record({
        id: application.sessionId,
        workspace: this.workspace,
        createdAt,
        lastUsedAt: this.now(),
        ...this.summarizeSession(history),
      });
    });
    this.sessionRecordTail = operation.catch(() => undefined);
    return operation;
  }

  private withSessionRecord(run: AgentRun): AgentRun {
    const result = run.result.then(
      async (value) => {
        await this.recordCurrentSession().catch(() => undefined);
        return value;
      },
      async (error: unknown) => {
        await this.recordCurrentSession().catch(() => undefined);
        throw error;
      },
    );
    void result.catch(() => undefined);
    return { id: run.id, result, cancel: run.cancel };
  }

  private async relayEvents(application: Application): Promise<void> {
    for await (const event of application.events) this.eventQueue.push(event);
  }

  private assertIdle(message: string): void {
    if (this.isRunning) throw new Error(message);
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("Agent workspace is closed");
  }
}

/** Default catalog projection shared by conversational Agent products. */
export function summarizeSessionHistory(
  history: readonly SessionEvent[],
): Pick<SessionSummary, "title" | "preview" | "turnCount"> {
  const messages = history.flatMap((event) => {
    if (event.type !== "input.submitted" && event.type !== "assistant.completed") {
      return [];
    }
    const text = event.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .replace(/\s+/gu, " ")
      .trim();
    return text === "" ? [] : [text];
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
  const turnCount = history.filter((event) => event.type === "input.submitted").length;
  return {
    ...(title === "" ? {} : { title: truncate(title, 80) }),
    ...(preview === undefined ? {} : { preview: truncate(preview, 180) }),
    turnCount,
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function isDroppableWorkspaceEvent<ApplicationEvent, ExtensionEvent>(
  value: AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>,
  custom: ((
    event: AgentWorkspaceEvent<ApplicationEvent, unknown>,
  ) => boolean) | undefined,
): boolean {
  if (custom !== undefined) return custom(value);
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; event?: unknown };
  return candidate.type === "run.event" &&
    typeof candidate.event === "object" &&
    candidate.event !== null &&
    isStreamingMayEvent(candidate.event as import("@may/core").MayEvent);
}
