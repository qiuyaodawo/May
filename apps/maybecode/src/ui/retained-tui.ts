import {
  FullscreenRenderer,
  NodeTerminalDriver,
  TuiRuntime,
  TerminalImages,
  createTerminalClipboard,
  type Clipboard,
  type RuntimeRenderer,
  type RuntimeTerminal,
} from "@may/tui";
import { TranscriptStore } from "@may/tui/transcript";
import type { ApprovalRequest } from "@may/permissions";
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
import { presentMcpInteraction } from "../mcp-interaction-ui.js";
import { MaybeCodeTerminalWeb } from "../terminal-web.js";
import { formatGoal } from "../goal-commands.js";
import {
  delegationOrder,
  formatDelegationTree,
  renderDelegationTask,
} from "../delegation-commands.js";
import type { MaybeCodeKeymapOptions } from "../keymap.js";

export interface RunRetainedTerminalUIOptions {
  readonly terminal?: RuntimeTerminal;
  readonly renderer?: RuntimeRenderer;
  readonly clipboard?: Clipboard;
  readonly keymap?: MaybeCodeKeymapOptions;
}

/** Experimental retained-screen MaybeCode frontend. */
export async function runRetainedTerminalUI(
  app: MaybeCodeController,
  options: RunRetainedTerminalUIOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? new NodeTerminalDriver();
  const renderer = options.renderer ?? new FullscreenRenderer(terminal);
  const store = new TranscriptStore();
  const displayedSteering = new Set<string>();
  const images = new TerminalImages(undefined, terminal.imageSupport?.protocol, { cellSize: () => terminal.imageSupport?.cellSize });
  try {
    const history = await app.history();
    for (const event of history) if (event.type === "assistant.completed" || event.type === "input.submitted") await images.prepare(event.message.content);
    for (const event of history) if (event.type === "tool.completed" && event.content) await images.prepare(event.content);
    store.loadHistory(history);
    for (const event of history) {
      if (event.type === "input.submitted" && event.inputId) displayedSteering.add(event.inputId);
      if (event.type === "input.steering.delivered") for (const inputId of event.inputIds) displayedSteering.add(inputId);
    }
  } catch (error) {
    await app.close();
    throw error;
  }

  let runtime: TuiRuntime | undefined;
  let closing = false;
  let eventFailure: unknown;
  const pendingRuns = new Set<Promise<void>>();
  const observeRun = (result: Promise<unknown>): void => {
    const pending = result.then(() => undefined, error => {
      if (!closing && !isCancellation(error)) store.appendNotice("error", errorMessage(error));
    }).finally(() => {
      pendingRuns.delete(pending);
      if (!closing) view.setStatus(app.isRunning ? "Running" : "Ready");
    });
    pendingRuns.add(pending);
  };
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => resolveExit = resolve);
  const finish = (): void => {
    if (closing) return;
    closing = true;
    runtime?.stop();
    resolveExit();
  };
  const web = new MaybeCodeTerminalWeb(app, finish);
  const handleProcessSignal = (): void => {
    if (app.isRunning) app.cancel("Interrupted by process signal");
    finish();
  };
  const view = new MaybeCodePrototypeView({
    isRunning: () => app.isRunning,
    permissionMode: () => app.permissionMode,
    clipboard: options.clipboard ?? createTerminalClipboard({ output: terminal }),
    keymap: options.keymap ?? {
      ...(process.env.MAY_TUI_LEADER === undefined ? {} : { leader: process.env.MAY_TUI_LEADER }),
    },
    images,
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
        await handleCommand(value, app, store, view, finish, web, observeRun);
        return;
      }
      try {
        const run = await app.submit({ input: value });
        accepted?.();
        observeRun(run.result);
      } catch (error) {
        if (!isCancellation(error)) throw error;
      }
    },
  });
  process.on("SIGINT", handleProcessSignal);
  process.on("SIGTERM", handleProcessSignal);
  void refreshModelLabel(view, app);

  runtime = new TuiRuntime({ terminal, renderer, root: view });
  let eventTask: Promise<void> | undefined;
  try {
    runtime.start();
    eventTask = consumeEvents(app, store, view, () => closing, web.events, images, displayedSteering).catch((error) => {
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
    await web.close();
    await Promise.all(pendingRuns);
    await eventTask;
  }
  if (eventFailure !== undefined) throw eventFailure;
}

async function consumeEvents(
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodePrototypeView,
  isClosing: () => boolean,
  events: AsyncIterable<MaybeCodeEvent>,
  images: TerminalImages,
  displayedSteering: Set<string>,
): Promise<void> {
  const approvals = new Set<Promise<void>>();
  const interactions = new Map<string, AbortController>();
  const delegationStatus = new Map<string, string>();
  let lastGoalDisplay = "";
  for await (const event of events) {
    if (event.type === "run.event") {
      if (event.event.type === "run.started") {
        view.setStatus("Running");
        const unread = app.listSteeringInputs?.().filter(input => input.status === "delivered" && !displayedSteering.has(input.inputId)) ?? [];
        if (unread.length > 0) {
          const history = await app.history();
          const runId = event.event.runId;
          const runIndex = history.findIndex(item => item.type === "run.started" && item.runId === runId);
          const submitted = runIndex < 0 ? undefined : history.slice(0, runIndex).reverse().find(item => item.type === "input.submitted");
          if (submitted?.type === "input.submitted" && submitted.inputId && unread.some(input => input.inputId === submitted.inputId)) {
            store.appendUser(submitted.message.content.filter(part => part.type === "text").map(part => part.text).join(""));
            displayedSteering.add(submitted.inputId);
          }
        }
      }
      if (event.event.type === "input.received") {
        for (const input of app.listSteeringInputs?.() ?? []) {
          if (input.status === "delivered" && input.runId === event.event.runId) displayedSteering.add(input.inputId);
        }
      }
      // 主 Run 让出时子任务还在运行，状态不能显示为 Ready。
      if (event.event.type === "run.completed" || event.event.type === "run.yielded" || event.event.type === "run.cancelled") {
        view.setStatus(app.isRunning ? "Delegating" : "Ready");
      }
      if (event.event.type === "run.failed") view.setStatus(`Error: ${event.event.error.message}`);
    }
    if (event.type === "permission-mode.changed") {
      view.setStatus(event.mode === "yolo" ? "YOLO enabled" : "YOLO disabled");
    }
    if (event.type === "run.event" && event.event.type === "model.completed") await images.prepare(event.event.message.content);
    if (event.type === "run.event" && event.event.type === "tool.completed") await images.prepare(event.event.content);
    if (event.type === "goal.changed") {
      view.setStatus(`Goal ${event.goal.status}`);
      const display = `${event.goal.id}:${event.goal.status}:${event.goal.progress}`;
      if (display !== lastGoalDisplay) {
        lastGoalDisplay = display;
        store.appendNotice("info", formatGoal(event.goal));
      }
    }
    if (event.type === "delegation.started" || event.type === "delegation.finished") {
      const label = event.type === "delegation.started" ? "Sub-agent request" : "Sub-agent request finished";
      store.appendNotice("info", `${label}\n${formatDelegationTree(event.state)}`);
      view.setStatus(event.type === "delegation.started" ? "Delegating" : "Ready");
    } else if (event.type === "delegation.updated") {
      // 只有任务进入终态时才写入记录，运行中的重复状态不显示。
      for (const task of delegationOrder(event.state.tasks)) {
        const previous = delegationStatus.get(task.id);
        delegationStatus.set(task.id, task.status);
        if (previous === task.status || !["completed", "failed", "cancelled", "recovery-required"].includes(task.status)) continue;
        store.appendNotice(task.status === "completed" ? "info" : "warning", renderDelegationTask(task));
      }
    }
    applyMaybeCodeEvent(store, event);
    if (event.type === "mcp.interaction.requested") {
      const controller = new AbortController();
      interactions.set(event.request.id, controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.ceil(event.request.expiresAt - Date.now())))]);
      const task = presentMcpInteraction(event.request, app, (prompt, signal) => view.requestMcpInput(prompt, signal), signal)
        .catch(() => { if (!isClosing() && !signal.aborted) {
          store.appendNotice("warning", "MCP interaction could not be completed");
          app.cancel("User interaction is unavailable");
        } })
        .finally(() => interactions.delete(event.request.id));
      approvals.add(task); void task.finally(() => approvals.delete(task));
    } else if (event.type === "mcp.interaction.settled") interactions.get(event.requestId)?.abort();
    if (event.type === "model.changed") {
      void refreshModelLabel(view, app);
    }
    if (event.type === "session.changed" && event.resumed) {
      const history = await app.history();
      for (const event of history) if (event.type === "assistant.completed" || event.type === "input.submitted") await images.prepare(event.message.content);
      for (const event of history) if (event.type === "tool.completed" && event.content) await images.prepare(event.content);
      store.loadHistory(history);
      displayedSteering.clear();
      for (const event of history) {
        if (event.type === "input.submitted" && event.inputId) displayedSteering.add(event.inputId);
        if (event.type === "input.steering.delivered") for (const inputId of event.inputIds) displayedSteering.add(inputId);
      }
      store.appendNotice("info", "Session resumed");
      continue;
    }
    if (
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ) {
      const task = presentApproval(app, view, store, event.event.request, isClosing, approvals);
      approvals.add(task);
      void task.finally(() => approvals.delete(task));
    } else if (
      event.type === "permission.event" &&
      (event.event.type === "approval.resolved" ||
        event.event.type === "approval.cancelled")
    ) {
      view.dismissApproval(event.event.requestId);
    }
    if (event.type === "delegation.event" && event.event.type === "permission.event") {
      // 子任务审批：包在外层事件里，同样需要界面与路由。
      const inner = event.event.event;
      if (inner.type === "approval.requested") {
        store.appendNotice("info", `子任务 ${event.taskId} 请求批准 ${inner.request.tool.name}`);
        const task = presentApproval(app, view, store, inner.request, isClosing, approvals);
        approvals.add(task);
        void task.finally(() => approvals.delete(task));
      } else {
        view.dismissApproval(inner.requestId);
      }
    }
  }
  for (const controller of interactions.values()) controller.abort();
  await Promise.all(approvals);
}

/** 打开审批对话框并把决定交回宿主，由宿主路由到提出请求的 Session。 */
function presentApproval(
  app: MaybeCodeController,
  view: MaybeCodePrototypeView,
  store: TranscriptStore,
  request: ApprovalRequest,
  isClosing: () => boolean,
  approvals: Set<Promise<void>>,
): Promise<void> {
  return view.requestApproval(request).then(async (decision) => {
    if (decision !== undefined && !isClosing()) {
      await app.resolveApproval(request.id, decision);
    }
  }).catch((error: unknown) => {
    if (!isClosing()) {
      store.appendNotice("error", `Approval failed: ${errorMessage(error)}`);
    }
  });
}

function applyMaybeCodeEvent(
  store: TranscriptStore,
  event: MaybeCodeEvent,
): void {
  switch (event.type) {
    case "run.event":
      store.applyMayEvent(event.event);
      break;
    case "delegation.event":
      // 子 Agent 的 Run 与审批事件进入同一个记录流，Run 身份彼此独立。
      if (event.event.type === "run.event") store.applyMayEvent(event.event.event);
      else if (event.event.type === "permission.event") store.applyPermissionEvent(event.event.event);
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
    case "mcp.resource.updated":
      store.appendNotice("info", `MCP resource updated: ${event.serverId} ${event.uri}`);
      break;
    case "mcp.resource.watch-closed":
      store.appendNotice("info", `MCP resource watch closed: ${event.serverId} ${event.uri} (${event.reason})`);
      break;
    case "mcp.server.connected":
      store.appendNotice(
        "info",
        `MCP server connected: ${event.serverId} ` +
          `(${event.toolNames.length} tools)`,
      );
      break;
    case "mcp.server.catalog-updated":
      store.appendNotice("info", `MCP catalog updated: ${event.serverId} (revision ${event.revision})`);
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
  web: MaybeCodeTerminalWeb,
  observeRun: (result: Promise<unknown>) => void,
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
  if (result.type === "web.requested") {
    store.appendNotice("info", `Web UI 已打开：${await web.open()}`);
    return;
  }
  await presentCommandResult(result, app, store, view, finish, observeRun);
}

async function presentCommandResult(
  result: MaybeCodeSlashCommandResult,
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodePrototypeView,
  finish: () => void,
  observeRun: (result: Promise<unknown>) => void,
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
    case "mcp.run-started":
    case "skill.run-started":
    case "retry.started":
      observeRun(result.run.result);
      break;
    case "status":
      store.appendNotice(
        "info",
        `Session: ${app.sessionId}\nWorkspace: ${app.workspace}\n` +
          `Permissions: ${app.permissionMode === "yolo" ? "YOLO · Auto-approve" : "Default"}\n` +
          `Model: ${await resolvedModelLabel(app)}${inspectionText(result.inspection)}`,
      );
      break;
    case "display":
    case "mcp.display":
      store.appendNotice("info", result.text);
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
