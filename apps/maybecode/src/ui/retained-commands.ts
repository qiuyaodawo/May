import type { TranscriptStore } from "@sortedyuan/tui/transcript";
import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import type { MaybeCodeController, MaybeCodeModelProfile, MaybeCodeReasoningEffortState } from "../controller.js";
import {
  formatMaybeCodeMcpStatus,
  parseMaybeCodeSlashCommand,
  type MaybeCodeSlashCommandResult,
} from "../slash-commands.js";
import { executeMaybeCodeSlashCommand } from "../slash-command-execution.js";
import type { MaybeCodeTerminalView } from "./terminal-view.js";
import type { MaybeCodeTerminalWeb } from "../terminal-web.js";
import {
  errorMessage,
  modelLabel,
  reasoningEffortChanged,
  reasoningEffortUnavailable,
  refreshModelLabel,
  resolvedModelLabel,
} from "./retained-labels.js";

export async function handleCommand(
  input: string,
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodeTerminalView,
  finish: () => void,
  web: MaybeCodeTerminalWeb,
  observeRun: (result: Promise<unknown>) => void,
): Promise<void> {
  const parsed = parseMaybeCodeSlashCommand(input);
  if (parsed.type === "command" && parsed.definition.name === "/compact" && parsed.arguments.length === 0) {
    store.appendNotice("info", "Pruning old tool results and summarizing context");
  }
  const result = await executeMaybeCodeSlashCommand(input, app);
  if (result.type === "web.requested") {
    store.appendNotice("info", `Web UI 已打开：${await web.open()}`);
    return;
  }
  await presentCommandResult(result, app, store, view, finish, observeRun);
}

async function presentCommandResult(
  result: Exclude<MaybeCodeSlashCommandResult, { readonly type: "web.requested" }>,
  app: MaybeCodeController,
  store: TranscriptStore,
  view: MaybeCodeTerminalView,
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
          ...result.commands.map((command) => `${command.usage} — ${command.description}`),
          ...view.displayCommands.map((command) => `${command.command} — ${command.description} (display only)`),
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
    case "fork.selection.requested": {
      const selection = await view.requestForkSelection(result.points, app.sessionId);
      if (selection) {
        if (!app.forkSession) throw new Error("Session 分支能力不可用。");
        const id = await app.forkSession(selection.pointId, selection.mode);
        store.appendNotice("info", `Session 分支已创建：${id}`);
        if (app.getWorkspaceGit) view.setWorkspaceGit(await app.getWorkspaceGit());
      }
      break;
    }
    case "changes.selection.requested":
      await view.requestChanges(result.diff, {
        ...(result.diff.runId && app.previewRestore
          ? { onRestore: async (path: string) => (await app.previewRestore!(result.diff.runId!, [path])).diff }
          : {}),
        ...(app.restoreFiles ? { onApply: (previewId: string) => app.restoreFiles!(previewId) } : {}),
      });
      break;
    case "worktrees.display":
      store.appendNotice(
        "info",
        result.worktrees.length
          ? result.worktrees
              .map((item) => `${item.id}\n${item.path}\n${item.branch} · ${item.status} · ${item.commit.slice(0, 12)}`)
              .join("\n\n")
          : "没有已登记的 worktree。",
      );
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
      store.appendNotice("warning", `No model profile starts with: ${result.query}`);
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
      store.appendNotice("warning", `No reasoning effort starts with: ${result.query}`);
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
  view: MaybeCodeTerminalView,
  app: MaybeCodeController,
  store: TranscriptStore,
  state: MaybeCodeReasoningEffortState,
): Promise<void> {
  const effort = await view.requestReasoningEffortSelection(state);
  if (effort === undefined) return;
  try {
    const changed = await app.setReasoningEffort(effort === "default" ? undefined : effort);
    view.setModel(modelLabel(app, changed));
    store.appendNotice("info", reasoningEffortChanged(changed));
  } catch (error) {
    store.appendNotice("error", errorMessage(error));
  }
}

async function runModelDialog(
  view: MaybeCodeTerminalView,
  app: MaybeCodeController,
  store: TranscriptStore,
  initialModels: readonly MaybeCodeModelProfile[],
): Promise<void> {
  let models = initialModels;
  while (true) {
    const action = await view.requestModelAction(models, app.application.modelInfo?.profile);
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
  view: MaybeCodeTerminalView,
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
          deleted ? `Deleted session ${action.sessionId}` : `Session ${action.sessionId} was not found`,
        );
      }
      sessions = await app.listSessions();
    } catch (error) {
      store.appendNotice("error", errorMessage(error));
      sessions = await app.listSessions();
    }
  }
}

function inspectionText(inspection: Awaited<ReturnType<MaybeCodeController["inspectContext"]>>): string {
  if (inspection === undefined) return "\nContext: unavailable";
  const window = inspection.contextWindowTokens === undefined ? "" : ` / ${inspection.contextWindowTokens}`;
  return `\nContext: ~${inspection.effectiveTokens}${window} tokens, ` + `${inspection.messageCount} messages`;
}
