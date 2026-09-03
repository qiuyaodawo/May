import {
  FullscreenRenderer,
  NodeTerminalDriver,
  TuiRuntime,
  type RuntimeRenderer,
  type RuntimeTerminal,
} from "@may/tui";
import { TranscriptStore } from "@may/tui/transcript";
import type { SessionSummary } from "@may/session/catalog";
import type {
  MaybeCodeController,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "../controller.js";
import {
  createMaybeCodeSlashCommandSuggester,
  executeMaybeCodeSlashCommand,
  formatMaybeCodeMcpStatus,
  parseMaybeCodeSlashCommand,
  type MaybeCodeSlashCommandResult,
} from "../slash-commands.js";
import { MaybeCodePrototypeView } from "./prototype-view.js";
import type { MaybeCodeEvent } from "../events.js";

export interface RunRetainedTerminalUIOptions {
  readonly terminal?: RuntimeTerminal;
  readonly renderer?: RuntimeRenderer;
}

/** Experimental retained-screen MaybeCode frontend. */
export async function runRetainedTerminalUI(
  app: MaybeCodeController,
  options: RunRetainedTerminalUIOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? new NodeTerminalDriver();
  const renderer = options.renderer ?? new FullscreenRenderer(terminal);
  const store = new TranscriptStore();
  try {
    store.loadHistory(await app.history());
  } catch (error) {
    await app.close();
    throw error;
  }

  let runtime: TuiRuntime | undefined;
  let closing = false;
  let eventFailure: unknown;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => resolveExit = resolve);
  const finish = (): void => {
    if (closing) return;
    closing = true;
    runtime?.stop();
    resolveExit();
  };
  const handleProcessSignal = (): void => {
    if (app.isRunning) app.cancel("Interrupted by process signal");
    finish();
  };
  process.on("SIGINT", handleProcessSignal);
  process.on("SIGTERM", handleProcessSignal);

  const view = new MaybeCodePrototypeView({
    store,
    workspace: app.workspace,
    model: modelLabel(app),
    suggestions: createMaybeCodeSlashCommandSuggester(app),
    recordInput: (value) => !value.trimStart().startsWith("/"),
    onInvalidate: () => runtime?.requestRender(),
    onCancel: () => {
      if (app.isRunning) {
        app.cancel("Interrupted");
        view.setStatus("Cancelling");
      } else {
        finish();
      }
    },
    onSubmit: async (value, accepted) => {
      if (value.trimStart().startsWith("/")) {
        await handleCommand(value, app, store, view, finish);
        return;
      }
      try {
        const run = await app.submit({ input: value });
        accepted?.();
        await run.result;
      } catch (error) {
        if (!isCancellation(error)) throw error;
      }
    },
  });
  void refreshModelLabel(view, app);

  runtime = new TuiRuntime({ terminal, renderer, root: view });
  let eventTask: Promise<void> | undefined;
  try {
    runtime.start();
    eventTask = consumeEvents(app, store, view, () => closing).catch((error) => {
      eventFailure = error;
      store.appendNotice("error", `Event stream failed: ${errorMessage(error)}`);
      finish();
    });
    await exited;
  } finally {
    closing = true;
    process.removeListener("SIGINT", handleProcessSignal);
    process.removeListener("SIGTERM", handleProcessSignal);
    runtime.stop();
    view.dispose();
    await app.close();
    await eventTask;
  }
  if (eventFailure !== undefined) throw eventFailure;
}

async function consumeEvents(
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodePrototypeView,
  isClosing: () => boolean,
): Promise<void> {
  const approvals = new Set<Promise<void>>();
  for await (const event of app.events) {
    applyMaybeCodeEvent(store, event);
    if (event.type === "model.changed") {
      void refreshModelLabel(view, app);
    }
    if (event.type === "session.changed" && event.resumed) {
      store.loadHistory(await app.history());
      continue;
    }
    if (
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ) {
      const request = event.event.request;
      const task = view.requestApproval(request).then(async (decision) => {
        if (decision !== undefined && !isClosing()) {
          await app.resolveApproval(request.id, decision);
        }
      }).catch((error: unknown) => {
        if (!isClosing()) {
          store.appendNotice("error", `Approval failed: ${errorMessage(error)}`);
        }
      });
      approvals.add(task);
      void task.finally(() => approvals.delete(task));
    } else if (
      event.type === "permission.event" &&
      (event.event.type === "approval.resolved" ||
        event.event.type === "approval.cancelled")
    ) {
      view.dismissApproval(event.event.requestId);
    }
  }
  await Promise.all(approvals);
}

function applyMaybeCodeEvent(
  store: TranscriptStore,
  event: MaybeCodeEvent,
): void {
  switch (event.type) {
    case "run.event":
      store.applyMayEvent(event.event);
      break;
    case "permission.event":
      store.applyPermissionEvent(event.event);
      break;
    case "change.preview":
      store.appendChangePreview(
        event.runId,
        event.step,
        event.toolCallId,
        event.preview,
      );
      break;
    case "session.changed":
      store.reset(event.sessionId);
      store.appendNotice(
        "info",
        `Session ${event.resumed ? "resumed" : "started"}: ${event.sessionId}`,
      );
      break;
    case "model.changed": {
      const profile = event.model.profile === undefined
        ? ""
        : ` profile ${event.model.profile}`;
      store.appendNotice(
        "info",
        `Model switched to${profile}: ${event.model.provider}/${event.model.model}`,
      );
      break;
    }
    case "model.default.changed":
      store.appendNotice("info", `Default model set to ${event.profile}`);
      break;
    case "mcp.server.connected":
      store.appendNotice(
        "info",
        `MCP server connected: ${event.serverId} ` +
          `(${event.toolNames.length} tools)`,
      );
      break;
    case "mcp.server.failed":
      store.appendNotice(
        "warning",
        `MCP server failed: ${event.serverId}: ${event.diagnostic.message}`,
      );
      break;
    case "mcp.server.disconnected":
      store.appendNotice("info", `MCP server disconnected: ${event.serverId}`);
      break;
    case "context.compacted":
      store.appendNotice(
        "info",
        `Context compacted with ${event.strategy}: ` +
          `${event.before.messageCount} → ${event.after.messageCount} messages`,
      );
      break;
    case "context.compaction.failed":
      store.appendNotice(
        "warning",
        `Context compaction failed with ${event.strategy}: ${event.error.message}`,
      );
      break;
  }
}

async function handleCommand(
  input: string,
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodePrototypeView,
  finish: () => void,
): Promise<void> {
  const parsed = parseMaybeCodeSlashCommand(input);
  if (
    parsed.type === "command" &&
    parsed.definition.name === "/compact" &&
    parsed.arguments.length === 0
  ) {
    store.appendNotice(
      "info",
      "Pruning old tool results and summarizing context",
    );
  }
  const result = await executeMaybeCodeSlashCommand(input, app);
  await presentCommandResult(result, app, store, view, finish);
}

async function presentCommandResult(
  result: MaybeCodeSlashCommandResult,
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodePrototypeView,
  finish: () => void,
): Promise<void> {
  switch (result.type) {
    case "exit":
      finish();
      break;
    case "help":
      store.appendNotice(
        "info",
        [
          ...result.commands.map((command) =>
            `${command.usage} — ${command.description}`
          ),
          ...view.displayCommands.map((command) =>
            `${command.command} — ${command.description} (display only)`
          ),
        ].join("\n"),
      );
      break;
    case "instructions":
      store.appendNotice("info", result.instructions.effective);
      break;
    case "retry.started":
      await result.run.result.catch((error: unknown) => {
        if (!isCancellation(error)) throw error;
      });
      break;
    case "status":
      store.appendNotice(
        "info",
        `Session: ${app.sessionId}\nWorkspace: ${app.workspace}\n` +
          `Model: ${await resolvedModelLabel(app)}${inspectionText(result.inspection)}`,
      );
      break;
    case "mcp.status":
      store.appendNotice("info", formatMaybeCodeMcpStatus(result.servers));
      break;
    case "context":
      store.appendNotice(
        "info",
        result.inspection === undefined
          ? "Context inspection is unavailable"
          : inspectionText(result.inspection).replace(/^\n/u, ""),
      );
      break;
    case "compacted":
      store.appendNotice(
        "info",
        `Context ${result.result.changed ? "compacted" : "unchanged"} with ` +
          `${result.result.strategy}: ${result.result.before.messageCount} → ` +
          `${result.result.after.messageCount} messages`,
      );
      break;
    case "session.created":
      store.appendNotice("info", `Created session ${result.sessionId}`);
      break;
    case "session.selection.requested":
      await runSessionDialog(view, app, store, result.sessions);
      break;
    case "session.resumed":
      store.appendNotice("info", `Resumed session ${result.sessionId}`);
      break;
    case "model.selection.requested":
      await runModelDialog(view, app, store, result.models);
      break;
    case "model.switched":
      await refreshModelLabel(view, app);
      break;
    case "model.not-found":
      store.appendNotice(
        "warning",
        `No model profile starts with: ${result.query}`,
      );
      break;
    case "effort.selection.requested":
      if (result.state.status !== "known") {
        store.appendNotice("warning", reasoningEffortUnavailable(result.state));
      } else {
        await runEffortDialog(view, app, store, result.state);
      }
      break;
    case "effort.changed":
      view.setModel(modelLabel(app, result.state));
      store.appendNotice("info", reasoningEffortChanged(result.state));
      break;
    case "effort.not-found":
      store.appendNotice(
        "warning",
        `No reasoning effort starts with: ${result.query}`,
      );
      break;
    case "usage":
      store.appendNotice("warning", `Usage: ${result.usage}`);
      break;
    case "unknown":
      store.appendNotice("warning", `Unknown command: ${result.command}`);
      break;
  }
}

async function runEffortDialog(
  view: MaybeCodePrototypeView,
  app: MaybeCodeController,
  store: TranscriptStore,
  state: MaybeCodeReasoningEffortState,
): Promise<void> {
  const effort = await view.requestReasoningEffortSelection(state);
  if (effort === undefined) return;
  try {
    const changed = await app.setReasoningEffort(
      effort === "default" ? undefined : effort,
    );
    view.setModel(modelLabel(app, changed));
    store.appendNotice("info", reasoningEffortChanged(changed));
  } catch (error) {
    store.appendNotice("error", errorMessage(error));
  }
}

async function runModelDialog(
  view: MaybeCodePrototypeView,
  app: MaybeCodeController,
  store: TranscriptStore,
  initialModels: readonly MaybeCodeModelProfile[],
): Promise<void> {
  let models = initialModels;
  while (true) {
    const action = await view.requestModelAction(
      models,
      app.modelInfo?.profile,
    );
    if (action === undefined) return;
    try {
      if (action.type === "switch") {
        await app.switchModel(action.profile);
        await refreshModelLabel(view, app);
        return;
      }
      await app.setDefaultModel(action.profile);
      models = await app.listModels();
    } catch (error) {
      store.appendNotice("error", errorMessage(error));
      models = await app.listModels();
    }
  }
}

async function runSessionDialog(
  view: MaybeCodePrototypeView,
  app: MaybeCodeController,
  store: TranscriptStore,
  initialSessions: readonly SessionSummary[],
): Promise<void> {
  let sessions = initialSessions;
  while (true) {
    const action = await view.requestSessionAction(sessions, app.sessionId);
    if (action === undefined) return;
    try {
      if (action.type === "resume") {
        await app.resumeSession(action.sessionId);
        store.appendNotice("info", `Resumed session ${action.sessionId}`);
        return;
      }
      if (action.type === "rename") {
        await app.renameSession(action.sessionId, action.title);
        store.appendNotice("info", `Renamed session to ${action.title}`);
      } else {
        const deleted = await app.deleteSession(action.sessionId);
        store.appendNotice(
          deleted ? "info" : "warning",
          deleted
            ? `Deleted session ${action.sessionId}`
            : `Session ${action.sessionId} was not found`,
        );
      }
      sessions = await app.listSessions();
    } catch (error) {
      store.appendNotice("error", errorMessage(error));
      sessions = await app.listSessions();
    }
  }
}

function inspectionText(
  inspection: Awaited<ReturnType<MaybeCodeController["inspectContext"]>>,
): string {
  if (inspection === undefined) return "\nContext: unavailable";
  const window = inspection.contextWindowTokens === undefined
    ? ""
    : ` / ${inspection.contextWindowTokens}`;
  return `\nContext: ~${inspection.effectiveTokens}${window} tokens, ` +
    `${inspection.messageCount} messages`;
}

function modelLabel(
  app: MaybeCodeController,
  effort: MaybeCodeReasoningEffortState | "loading" = "loading",
): string {
  if (app.modelInfo === undefined) return "unknown · effort: unknown";
  const endpoint = `${app.modelInfo.provider}/${app.modelInfo.model}`;
  const model = app.modelInfo.profile === undefined
    ? endpoint
    : `${app.modelInfo.profile} (${endpoint})`;
  return `${model} · effort: ${reasoningEffortLabel(effort)}`;
}

function reasoningEffortLabel(
  state: MaybeCodeReasoningEffortState | "loading",
): string {
  if (state === "loading") return "…";
  if (state.status === "unsupported") return "n/a";
  if (state.status === "unknown") return "unknown";
  return state.effectiveEffort ?? state.defaultEffort ?? "default";
}

async function resolvedModelLabel(app: MaybeCodeController): Promise<string> {
  try {
    return modelLabel(app, await app.getReasoningEffort());
  } catch {
    return modelLabel(app, unknownReasoningEffort());
  }
}

async function refreshModelLabel(
  view: MaybeCodePrototypeView,
  app: MaybeCodeController,
): Promise<void> {
  const identity = modelIdentity(app);
  const label = await resolvedModelLabel(app);
  if (identity === modelIdentity(app)) view.setModel(label);
}

function modelIdentity(app: MaybeCodeController): string {
  const model = app.modelInfo;
  return model === undefined
    ? ""
    : `${model.profile ?? ""}\u0000${model.provider}\u0000${model.model}`;
}

function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

function reasoningEffortUnavailable(
  state: MaybeCodeReasoningEffortState,
): string {
  return state.status === "unsupported"
    ? "The active model does not support effort-based reasoning"
    : "Reasoning effort capability is unknown for the active model";
}

function reasoningEffortChanged(state: MaybeCodeReasoningEffortState): string {
  const effort = state.effectiveEffort ?? "provider/model default";
  return `Reasoning effort: ${effort}${state.overridden ? " (runtime override)" : ""}`;
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error && error.code === "RUN_CANCELLED"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
