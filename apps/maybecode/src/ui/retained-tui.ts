import {
  FullscreenRenderer,
  NodeTerminalDriver,
  TuiRuntime,
  TerminalImages,
  createTerminalClipboard,
  type Clipboard,
  type RuntimeRenderer,
  type RuntimeTerminal,
} from "@sortedyuan/tui";
import { TranscriptStore } from "@sortedyuan/tui/transcript";
import { omitUndefined } from "@sortedyuan/may/core";
import type { MaybeCodeController } from "../controller.js";
import { createMaybeCodeSlashCommandSuggester } from "../slash-command-suggestions.js";
import { MaybeCodeTerminalView } from "./terminal-view.js";
import { MaybeCodeTerminalWeb } from "../terminal-web.js";
import type { MaybeCodeKeymapOptions } from "../keymap.js";
import { consumeEvents } from "./retained-events.js";
import { handleCommand } from "./retained-commands.js";
import { errorMessage, isCancellation, modelLabel, refreshModelLabel } from "./retained-labels.js";

export interface RunRetainedTerminalUIOptions {
  readonly terminal?: RuntimeTerminal;
  readonly renderer?: RuntimeRenderer;
  readonly clipboard?: Clipboard;
  readonly keymap?: MaybeCodeKeymapOptions;
}

/** Default retained-screen MaybeCode terminal frontend. */
export async function runRetainedTerminalUI(
  app: MaybeCodeController,
  options: RunRetainedTerminalUIOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? new NodeTerminalDriver();
  const renderer = options.renderer ?? new FullscreenRenderer(terminal);
  const store = new TranscriptStore();
  const displayedSteering = new Set<string>();
  const images = new TerminalImages(undefined, terminal.imageSupport?.protocol, {
    cellSize: () => terminal.imageSupport?.cellSize,
  });
  try {
    const history = await app.history();
    for (const event of history)
      if (event.type === "assistant.completed" || event.type === "input.submitted")
        await images.prepare(event.message.content);
    for (const event of history)
      if (event.type === "tool.completed" && event.content) await images.prepare(event.content);
    store.loadHistory(history);
    if (app.application.modelInfo?.searchStatus) store.appendNotice("info", app.application.modelInfo.searchStatus);
    for (const event of history) {
      if (event.type === "input.submitted" && event.inputId) displayedSteering.add(event.inputId);
      if (event.type === "input.steering.delivered")
        for (const inputId of event.inputIds) displayedSteering.add(inputId);
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
    const pending = result
      .then(
        () => undefined,
        (error) => {
          if (!closing && !isCancellation(error)) store.appendNotice("error", errorMessage(error));
        },
      )
      .finally(() => {
        pendingRuns.delete(pending);
        if (!closing) view.setStatus(app.isRunning ? "Running" : "Ready");
      });
    pendingRuns.add(pending);
  };
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
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
  const view = new MaybeCodeTerminalView({
    isRunning: () => app.isRunning,
    permissionMode: () => app.permissionMode,
    clipboard: options.clipboard ?? createTerminalClipboard({ output: terminal }),
    keymap: options.keymap ?? omitUndefined({ leader: process.env.MAY_TUI_LEADER }),
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
  await refreshModelLabel(view, app);
  const refreshWorkspace = async () => {
    if (!app.getWorkspaceGit || closing) return;
    try {
      view.setWorkspaceGit(await app.getWorkspaceGit());
    } catch (error) {
      view.setWorkspaceGit({ path: app.workspace, status: "error", autoCommit: false, error: errorMessage(error) });
    }
  };
  await refreshWorkspace();
  let refreshingWorkspace = false;
  let workspaceTask: Promise<void> | undefined;
  const workspaceTimer = app.getWorkspaceGit
    ? setInterval(() => {
        if (refreshingWorkspace || closing) return;
        refreshingWorkspace = true;
        workspaceTask = refreshWorkspace()
          .catch((error) => {
            eventFailure = error;
            finish();
          })
          .finally(() => {
            refreshingWorkspace = false;
          });
      }, 2_000)
    : undefined;

  runtime = new TuiRuntime({ terminal, renderer, root: view });
  let eventTask: Promise<void> | undefined;
  try {
    runtime.start();
    eventTask = consumeEvents(app, store, view, () => closing, web.events, images, displayedSteering, finish).catch(
      (error) => {
        eventFailure = error;
        store.appendNotice("error", `Event stream failed: ${errorMessage(error)}`);
        finish();
      },
    );
    await exited;
  } finally {
    closing = true;
    if (workspaceTimer) clearInterval(workspaceTimer);
    process.removeListener("SIGINT", handleProcessSignal);
    process.removeListener("SIGTERM", handleProcessSignal);
    runtime.stop();
    view.dispose();
    const results = await Promise.allSettled([
      web.close(),
      ...pendingRuns,
      ...(workspaceTask ? [workspaceTask] : []),
      ...(eventTask ? [eventTask] : []),
    ]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) {
      if (eventFailure !== undefined) failures.push(eventFailure);
      throw new AggregateError(failures, "MaybeCode terminal failed to close");
    }
  }
  if (eventFailure !== undefined) throw eventFailure;
}
