import type {
  ContextCompactionResult,
  ContextCompactionStrategy,
  ContextInspection,
} from "@may/context";
import {
  AsyncEventQueue,
  isStreamingMayEvent,
} from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type {
  SessionEvent,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionStore,
  SessionSubmitOptions,
  SessionBranchNode,
  SessionBranchPosition,
} from "@may/session";
import { readSessionBranchNode, readSessionBranchPositions } from "@may/session";
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
  readonly fork?: import("./application.js").AgentApplicationFork;
  readonly workspace?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentWorkspaceForkOptions {
  readonly workspace?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  readonly workspacePaths?: () => readonly string[] | Promise<readonly string[]>;
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
  Run extends AgentRun = AgentRun,
  Application extends AgentController<
    ApplicationEvent,
    CompactionSelection,
    Run
  > = AgentController<ApplicationEvent, CompactionSelection, Run>,
> implements AgentWorkspaceController<
    ApplicationEvent,
    ExtensionEvent,
    CompactionSelection,
    Run
  > {
  readonly events: AsyncIterable<
    AgentWorkspaceEvent<ApplicationEvent, ExtensionEvent>
  >;
  private currentWorkspace: string;

  private readonly store: SessionStore;
  private readonly catalog: SessionCatalog;
  private readonly openApplication: AgentWorkspaceOptions<
    ApplicationEvent,
    CompactionSelection,
    Application
  >["openApplication"];
  private readonly summarizeSession: SessionSummaryFactory;
  private readonly now: () => number;
  private readonly workspacePaths: (() => readonly string[] | Promise<readonly string[]>) | undefined;
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
    this.workspacePaths = options.workspacePaths;
    this.currentWorkspace = options.workspace;
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
    Run extends AgentRun = AgentRun,
    Application extends AgentController<
      ApplicationEvent,
      CompactionSelection,
      Run
    > = AgentController<ApplicationEvent, CompactionSelection, Run>,
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
    Run,
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
    const paths = new Set([options.workspace, ...(await options.workspacePaths?.() ?? [])]);
    const summaries = sessionId === undefined ? [] : (await Promise.all([...paths].map((path) => options.catalog.list(path)))).flat();
    const selectedWorkspace = summaries.find((summary) => summary.id === sessionId)?.workspace ?? options.workspace;
    const application = await options.openApplication({
      ...(sessionId === undefined ? {} : { sessionId }),
      resume: resumed,
      workspace: selectedWorkspace,
    });
    if (sessionId !== undefined && application.sessionId !== sessionId) {
      await application.close();
      throw new Error(
        `Application resumed unexpected session "${application.sessionId}"; expected "${sessionId}"`,
      );
    }
    const workspace = new AgentWorkspace<
      ApplicationEvent,
      ExtensionEvent,
      CompactionSelection,
      Run,
      Application
    >(options, application, resumed);
    workspace.currentWorkspace = selectedWorkspace;
    await workspace.recordCurrentSession().catch(() => undefined);
    return workspace;
  }

  get sessionId(): string {
    return this.application.sessionId;
  }

  get workspace(): string {
    const application = this.application as Application & { readonly workspace?: string };
    return application.workspace ?? this.currentWorkspace;
  }

  get isRunning(): boolean {
    return this.application.isRunning;
  }

  /** Product wrappers may read application-owned metadata such as model info. */
  get activeApplication(): Application {
    return this.application;
  }

  async submit(options: SessionSubmitOptions): Promise<Run> {
    return this.state.run(async () => {
      const run = await this.application.submit(options);
      void this.recordCurrentSession().catch(() => undefined);
      return this.withSessionRecord(run);
    });
  }

  /** Prepare user input on the Session state queue, then submit to the same application. */
  submitPrepared(prepare: () => SessionSubmitOptions | Promise<SessionSubmitOptions>): Promise<Run> {
    this.throwIfClosed();
    return this.state.run(async () => {
      this.assertIdle("Cannot prepare input while an operation is active");
      const options = await prepare();
      options.signal?.throwIfAborted();
      const run = await this.application.submit(options);
      void this.recordCurrentSession().catch(() => undefined);
      return this.withSessionRecord(run);
    });
  }

  async retry(): Promise<Run> {
    return this.state.run(async () => {
      void this.recordCurrentSession().catch(() => undefined);
      return this.withSessionRecord(await this.application.retry());
    });
  }

  listRecoveries() { return this.application.listRecoveries?.() ?? []; }

  resolveRecovery(id: string, finding: string): Promise<void> {
    return this.state.run(async () => {
      this.assertIdle("Cannot resolve recovery while an operation is active");
      if (!this.application.resolveRecovery) throw new Error("Recovery resolution is unsupported");
      await this.application.resolveRecovery(id, finding);
      await this.recordCurrentSession();
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
    return this.listFamilySessions();
  }

  readSessionHistory(sessionId: string): Promise<readonly SessionEvent[]> {
    this.throwIfClosed();
    return this.state.run(async () => {
      const known = (await this.listFamilySessions()).some(session => session.id === sessionId);
      if (!known) throw new Error("Session does not belong to this workspace");
      if (!this.store.inspect) throw new Error("Session store does not support read-only inspection");
      return this.store.inspect(sessionId);
    });
  }

  async branchPositions(): Promise<readonly SessionBranchPosition[]> {
    return readSessionBranchPositions(await this.history());
  }

  readSessionBranchTree(): Promise<readonly SessionBranchNode[]> {
    this.throwIfClosed();
    return this.state.run(async () => {
      if (this.store.inspect === undefined) throw new Error("Session tree requires read-only store inspection");
      const sessions = await this.listFamilySessions();
      return Promise.all(sessions.map(async (session) => readSessionBranchNode(await this.store.inspect!(session.id))));
    });
  }

  forkSession(sourceId: string, positionSeq: number, options: AgentWorkspaceForkOptions = {}): Promise<string> {
    this.throwIfClosed();
    return this.state.run(async () => {
      this.assertIdle("Cannot fork sessions while an operation is active");
      const known = (await this.listFamilySessions()).some((session) => session.id === sourceId);
      if (!known) throw new Error("Source Session does not belong to this workspace");
      if (this.store.inspect === undefined) throw new Error("Session forking requires read-only store inspection");
      const position = readSessionBranchPositions(await this.store.inspect(sourceId)).find((value) => value.positionSeq === positionSeq);
      if (position === undefined || !position.available) throw new Error(position?.reason ?? "Selected history position has no recoverable state");
      const next = await this.openApplication({ resume: false, fork: { sessionId: sourceId, positionSeq },
        workspace: options.workspace ?? this.workspace, ...(options.metadata === undefined ? {} : { metadata: options.metadata }) });
      if (next.sessionId === sourceId) { await next.close(); throw new Error("Forked Session must have an independent identity"); }
      const forked = (await next.history())[0];
      if (forked?.type !== "session.created" || forked.fork?.sessionId !== sourceId || forked.fork.positionSeq !== positionSeq) {
        await next.close(); throw new Error("Application did not restore the selected Session branch position");
      }
      try { await this.recordCurrentSession(next, options.workspace ?? this.workspace); }
      catch (error) {
        try { await next.close(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `Forked Session "${next.sessionId}" catalog persistence and cleanup failed`, { cause: error }); }
        throw new Error(`Forked Session "${next.sessionId}" could not be recorded in the catalog; its history is preserved`, { cause: error });
      }
      const previousWorkspace = this.currentWorkspace;
      this.currentWorkspace = options.workspace ?? this.currentWorkspace;
      try { await this.replaceApplication(next, false); }
      catch (error) { this.currentWorkspace = previousWorkspace; throw error; }
      this.eventQueue.push({ type: "session.forked", sessionId: next.sessionId, sourceId, positionSeq, workspace: this.workspace });
      return next.sessionId;
    });
  }

  async newSession(): Promise<string> {
    return this.state.run(async () => {
      this.assertIdle("Cannot switch sessions while an operation is active");
      const next = await this.openApplication({ resume: false, workspace: this.workspace });
      await this.replaceApplication(next, false);
      return next.sessionId;
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    return this.state.run(async () => {
      this.assertIdle("Cannot switch sessions while an operation is active");
      if (sessionId === this.sessionId) return;
      const summary = (await this.listFamilySessions()).find((session) => session.id === sessionId);
      if (summary === undefined) throw new Error("Session does not belong to this workspace family");
      const next = await this.openApplication({ sessionId, resume: true, workspace: summary.workspace });
      if (next.sessionId !== sessionId) {
        await next.close();
        throw new Error(
          `Application resumed unexpected session "${next.sessionId}"; expected "${sessionId}"`,
        );
      }
      const previousWorkspace = this.currentWorkspace;
      this.currentWorkspace = summary.workspace;
      try { await this.replaceApplication(next, true); }
      catch (error) { this.currentWorkspace = previousWorkspace; throw error; }
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
      const summary = (await this.listFamilySessions()).find((session) => session.id === sessionId);
      if (summary === undefined || !await rename.call(this.catalog, sessionId, summary.workspace, normalized)) {
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
      const summary = (await this.listFamilySessions()).find((session) => session.id === sessionId);
      if (summary === undefined) return false;
      const historyRemoved = await removeHistory.call(this.store, sessionId);
      const catalogRemoved = await removeCatalog.call(
        this.catalog,
        sessionId,
        summary.workspace,
      );
      return historyRemoved || catalogRemoved;
    });
  }

  history(): Promise<readonly SessionEvent[]> {
    return this.application.history();
  }

  queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
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

  private async recordCurrentSession(application = this.application, workspace = this.workspace): Promise<void> {
    const operation = this.sessionRecordTail.then(async () => {
      const history = await application.history();
      const createdAt = history[0]?.timestamp ?? this.now();
      await this.catalog.record({
        id: application.sessionId,
        workspace,
        createdAt,
        lastUsedAt: this.now(),
        ...this.summarizeSession(history),
      });
    });
    this.sessionRecordTail = operation.catch(() => undefined);
    return operation;
  }

  private async listFamilySessions(): Promise<readonly SessionSummary[]> {
    const paths = new Set([this.workspace, ...(await this.workspacePaths?.() ?? [])]);
    const sessions = (await Promise.all([...paths].map((path) => this.catalog.list(path)))).flat();
    return [...new Map(sessions.map((session) => [session.id, session])).values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private withSessionRecord(run: Run): Run {
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
    // 浅拷贝保留产品自己附加在 Run 上的字段，例如请求身份。
    return { ...run, result } as Run;
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
