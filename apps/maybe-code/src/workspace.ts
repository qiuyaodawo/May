import { AsyncEventQueue, type RunOptions } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";

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

export interface MaybeCodeWorkspaceOptions extends Omit<
  MaybeCodeApplicationOptions,
  "sessionId" | "resume"
> {
  readonly catalog: SessionCatalog;
  readonly sessionId?: string;
  readonly autoResume?: boolean;
}

export class MaybeCodeWorkspace {
  readonly events: AsyncIterable<MaybeCodeEvent>;
  readonly workspace: string;

  private readonly options: Omit<
    MaybeCodeWorkspaceOptions,
    "sessionId" | "autoResume"
  >;
  private readonly eventQueue = new AsyncEventQueue<MaybeCodeEvent>();
  private application: MaybeCodeApplication;
  private eventRelay: Promise<void>;
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
    if (sessionId === undefined && options.autoResume !== false) {
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

  async submit(options: RunOptions): Promise<MaybeCodeRun> {
    this.throwIfClosed();
    await this.recordCurrentSession();
    return this.application.submit(options);
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

  history() {
    return this.application.history();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.application.close();
    await this.eventRelay;
    this.eventQueue.close();
  }

  private async replaceApplication(
    next: MaybeCodeApplication,
    resumed: boolean,
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
    this.eventQueue.push({
      type: "session.changed",
      sessionId: next.sessionId,
      resumed,
    });
  }

  private async recordCurrentSession(): Promise<void> {
    const history = await this.application.history();
    const createdAt = history[0]?.timestamp ?? Date.now();
    await this.options.catalog.record({
      id: this.application.sessionId,
      workspace: this.workspace,
      createdAt,
      lastUsedAt: Date.now(),
    });
  }

  private async relayEvents(application: MaybeCodeApplication): Promise<void> {
    for await (const event of application.events) {
      this.eventQueue.push(event);
    }
  }

  private assertIdle(): void {
    if (this.isRunning) {
      throw new Error("Cannot switch sessions while a run is active");
    }
  }

  private throwIfClosed(): void {
    if (this.closed) throw new Error("MaybeCode workspace is closed");
  }
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
    ...application
  } = options;
  return application;
}
