import type { ContentPart, MayEvent } from "@may/core";
import type { ContextInspection } from "@may/context";
import type { ApprovalRequest, PermissionEvent } from "@may/permissions";
import type { SessionEvent } from "@may/session";
import { sanitizeTerminalText } from "@may/tui";

import type { FileChangeKind, ToolChangePreview } from "@may/coding-tools/change-preview";
import type { MaybeCodeEvent } from "./events.js";
import {
  createMaybeCodeSlashCommandSuggester,
  executeMaybeCodeSlashCommand,
  formatMaybeCodeMcpStatus,
  parseMaybeCodeSlashCommand,
  type MaybeCodeSlashCommand,
  type MaybeCodeSlashCommandResult,
} from "./slash-commands.js";
import type {
  TerminalIO,
  TerminalQuestionOptions,
} from "@may/tui/node-terminal";
import { createNodeTerminal } from "@may/tui/node-terminal";
import type {
  MaybeCodeController,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import { runModelPicker } from "./model-picker.js";
import { runSessionPicker } from "./session-picker.js";
import { presentMcpInteraction } from "./mcp-interaction-ui.js";

type UIQuestion = (
  prompt: string,
  options?: TerminalQuestionOptions,
) => Promise<string>;

export interface RunTerminalUIOptions {
  readonly terminal?: TerminalIO;
}

export async function runTerminalUI(
  app: MaybeCodeController,
  options: RunTerminalUIOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? createNodeTerminal();
  let terminalClosed = false;
  const closeTerminal = (): void => {
    if (terminalClosed) return;
    terminalClosed = true;
    terminal.close();
  };
  const renderer = new TerminalRenderer(terminal);
  const slashCommandSuggestions = createMaybeCodeSlashCommandSuggester(app);
  let activeQuestion: AbortController | undefined;
  let exit = false;
  const handleProcessSignal = (): void => {
    exit = true;
    if (app.isRunning) app.cancel("Interrupted by process signal");
    activeQuestion?.abort();
    closeTerminal();
  };
  process.on("SIGINT", handleProcessSignal);
  process.on("SIGTERM", handleProcessSignal);

  const question: UIQuestion = async (prompt, questionOptions = {}) => {
    const controller = new AbortController();
    activeQuestion = controller;
    try {
      return await terminal.question(prompt, {
        ...questionOptions,
        signal: questionOptions.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, questionOptions.signal]),
      });
    } finally {
      if (activeQuestion === controller) activeQuestion = undefined;
    }
  };

  const removeInterrupt = terminal.onInterrupt?.(() => {
    if (app.isRunning) {
      terminal.write("\nCancelling current operation...\n");
      app.cancel("Interrupted");
      activeQuestion?.abort();
    } else {
      exit = true;
      activeQuestion?.abort();
    }
  });

  const eventTask = consumeEvents(app, renderer, question);
  terminal.write(sanitizeTerminalText(
    `MaybeCode\nWorkspace: ${app.workspace}\n` +
      `Model: ${modelLabel(app)}\n` +
      `${renderInstructionSources(app)}` +
      "Type /help for commands. End a line with \\ for multiline input.\n",
  ));

  try {
    while (!exit) {
      let input: string;
      try {
        input = await readInput(question, slashCommandSuggestions);
      } catch (error) {
        if (isAbortError(error)) {
          if (!app.isRunning) break;
          continue;
        }
        throw error;
      }

      if (input === "") continue;
      terminal.addHistory?.(input);
      if (input.startsWith("/")) {
        try {
          exit = await handleCommand(input, app, terminal, question);
        } catch (error) {
          if (!isCancellation(error) && !isAbortError(error)) {
            terminal.write(
              `\nError: ${sanitizeTerminalText(errorMessage(error))}\n`,
            );
          }
        }
        continue;
      }

      try {
        const run = await app.submit({ input });
        await run.result;
      } catch (error) {
        if (!isCancellation(error)) {
          terminal.write(
            `\nError: ${sanitizeTerminalText(errorMessage(error))}\n`,
          );
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", handleProcessSignal);
    process.removeListener("SIGTERM", handleProcessSignal);
    activeQuestion?.abort();
    removeInterrupt?.();
    // Restore readline/raw terminal state before potentially slow application
    // cancellation and event-drain work.
    closeTerminal();
    await app.close();
    await eventTask;
  }
}

async function consumeEvents(
  app: MaybeCodeController,
  renderer: TerminalRenderer,
  question: UIQuestion,
): Promise<void> {
  const pending = new Map<string, AbortController>();
  let prompts = Promise.resolve();
  const enqueue = (id: string, work: (signal: AbortSignal) => Promise<void>, expiresAt?: number) => {
    const controller = new AbortController();
    pending.set(id, controller);
    const signal = expiresAt === undefined ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.ceil(expiresAt - Date.now())))]);
    prompts = prompts.then(async () => { if (!signal.aborted) await work(signal); }).catch(() => {
      if (!signal.aborted) {
        renderer.write("\nInteraction could not be completed.\n");
        app.cancel("User interaction is unavailable");
      }
    }).finally(() => pending.delete(id));
  };
  for await (const event of app.events) {
    if (event.type === "run.event") {
      renderer.runEvent(event.event);
    } else if (event.type === "permission.event") {
      if (event.event.type === "approval.requested") {
        enqueue(`approval:${event.event.request.id}`, (signal) => handlePermissionEvent(event.event, app, renderer,
          (prompt, options) => question(prompt, { ...options, signal })));
      } else {
        if (event.event.type === "approval.resolved" || event.event.type === "approval.cancelled") pending.get(`approval:${event.event.requestId}`)?.abort();
        renderer.permissionEvent(event.event);
      }
    } else if (event.type === "mcp.interaction.requested") {
      enqueue(event.request.id, (signal) => presentMcpInteraction(event.request, app,
        (prompt, signal) => question(prompt, { history: false, signal }), signal), event.request.expiresAt);
    } else if (event.type === "mcp.interaction.settled") {
      pending.get(event.requestId)?.abort();
    } else if (event.type === "change.preview") {
      renderer.changePreview(event);
    } else if (event.type === "context.compacted") {
      renderer.contextCompacted(event);
    } else if (event.type === "context.compaction.failed") {
      renderer.contextCompactionFailed(event);
    } else if (event.type === "model.changed") {
      renderer.modelChanged(event.model);
    } else if (event.type === "model.default.changed") {
      renderer.defaultModelChanged(event.profile);
    } else if (
      event.type === "mcp.resource.updated" ||
      event.type === "mcp.resource.watch-closed" ||
      event.type === "mcp.server.connected" ||
      event.type === "mcp.server.catalog-updated" ||
      event.type === "mcp.server.failed" ||
      event.type === "mcp.server.disconnected"
    ) {
      renderer.mcpEvent(event);
    } else {
      await renderer.sessionChanged(event, app);
    }
  }
  for (const controller of pending.values()) controller.abort();
  await prompts;
}

async function handlePermissionEvent(
  event: PermissionEvent,
  app: MaybeCodeController,
  renderer: TerminalRenderer,
  question: UIQuestion,
): Promise<void> {
  if (event.type !== "approval.requested") {
    renderer.permissionEvent(event);
    return;
  }

  renderer.approvalRequest(event.request);
  while (true) {
    const choices = event.request.grantKey === undefined
      ? "[a]llow once / [d]eny"
      : permissionChoices(event.request.tool.name);
    let answer: string;
    try {
      answer = (await question(`${choices}: `, { history: false }))
        .trim()
        .toLowerCase();
    } catch (error) {
      if (isAbortError(error)) return;
      throw error;
    }

    const decision = answer === "a" || answer === "allow" || answer === "y"
      ? "allow"
      : answer === "d" || answer === "deny" || answer === "n"
      ? "deny"
      : answer === "s" || answer === "session"
      ? "allow-session"
      : undefined;
    if (decision === undefined) {
      renderer.write("Please enter a, s, or d.\n");
      continue;
    }
    if (decision === "allow-session" && event.request.grantKey === undefined) {
      renderer.write("This request cannot be granted for the session.\n");
      continue;
    }
    await app.resolveApproval(event.request.id, decision);
    return;
  }
}

async function handleCommand(
  input: string,
  app: MaybeCodeController,
  terminal: TerminalIO,
  question: UIQuestion,
): Promise<boolean> {
  const parsed = parseMaybeCodeSlashCommand(input);
  if (
    parsed.type === "command" &&
    parsed.definition.name === "/retry" &&
    parsed.arguments.length === 0
  ) {
    terminal.write("\nRetrying the latest failed run...\n");
  }
  if (
    parsed.type === "command" &&
    parsed.definition.name === "/compact" &&
    parsed.arguments.length === 0
  ) {
    terminal.write("\nPruning old tool results and summarizing context...\n");
  }

  const result = await executeMaybeCodeSlashCommand(input, app);
  return renderSlashCommandResult(result, app, terminal, question);
}

async function renderSlashCommandResult(
  result: MaybeCodeSlashCommandResult,
  app: MaybeCodeController,
  terminal: TerminalIO,
  question: UIQuestion,
): Promise<boolean> {
  switch (result.type) {
    case "exit":
      return true;
    case "help":
      terminal.write(`\n${renderSlashCommandHelp(result.commands)}`);
      break;
    case "instructions":
      terminal.write(sanitizeTerminalText(
        `\n${renderInstructionSources(app)}` +
          `Effective instructions:\n---\n${result.instructions.effective}\n---\n`,
      ));
      break;
    case "mcp.run-started":
    case "retry.started":
      await result.run.result;
      break;
    case "status":
      terminal.write(`\n${renderStatus(app, result.inspection)}`);
      break;
    case "mcp.display":
      terminal.write(`\n${sanitizeTerminalText(result.text)}\n`);
      break;
    case "mcp.status":
      terminal.write(
        `\n${sanitizeTerminalText(formatMaybeCodeMcpStatus(result.servers))}\n`,
      );
      break;
    case "context":
      terminal.write(
        result.inspection === undefined
          ? "\nContext inspection is not supported by the active context.\n"
          : `\n${renderContextInspection(result.inspection)}`,
      );
      break;
    case "compacted":
      terminal.write(`\n${renderCompactionResult(result.result)}`);
      break;
    case "session.created":
      terminal.write(`\nCreated session ${result.sessionId}\n`);
      break;
    case "session.selection.requested": {
      const selection = await runSessionPicker({
        controller: app,
        terminal,
        sessions: result.sessions,
        question: (prompt) => question(prompt, { history: false }),
      });
      if (selection.type === "empty") {
        terminal.write("\nNo sessions found for this workspace.\n");
      } else if (selection.type === "resume") {
        await app.resumeSession(selection.sessionId);
        terminal.write(`\nResumed session ${selection.sessionId}\n`);
      }
      break;
    }
    case "session.resumed":
      terminal.write(`\nResumed session ${result.sessionId}\n`);
      break;
    case "model.selection.requested": {
      let models = result.models;
      while (true) {
        const selection = await runModelPicker({
          controller: app,
          terminal,
          models,
          question: (prompt) => question(prompt, { history: false }),
        });
        if (selection.type === "empty") {
          terminal.write("\nNo model profiles are configured.\n");
          break;
        }
        if (selection.type === "cancelled") break;
        if (selection.type === "select") {
          await app.switchModel(selection.profile);
          break;
        }
        await app.setDefaultModel(selection.profile);
        models = await app.listModels();
      }
      break;
    }
    case "model.switched":
      break;
    case "model.not-found":
      terminal.write(
        `\nNo model profile starts with: ` +
          `${sanitizeTerminalText(result.query)}\n`,
      );
      break;
    case "effort.selection.requested": {
      if (result.state.status !== "known") {
        terminal.write(`\n${renderReasoningEffortState(result.state)}\n`);
        break;
      }
      const choices = ["default", ...result.state.efforts];
      terminal.write(`\n${renderReasoningEffortState(result.state)}`);
      for (const [index, effort] of choices.entries()) {
        terminal.write(
          `  ${index + 1}. ${sanitizeTerminalText(effort)}\n`,
        );
      }
      const answer = (await question(
        "Select an effort number or name (Enter to cancel): ",
        { history: false },
      )).trim().toLowerCase();
      if (answer !== "") {
        const numeric = Number(answer);
        const selected = Number.isSafeInteger(numeric) && numeric > 0
          ? choices[numeric - 1]
          : choices.find((choice) => choice.startsWith(answer));
        if (selected === undefined) {
          terminal.write(
            `\nNo reasoning effort starts with: ` +
              `${sanitizeTerminalText(answer)}\n`,
          );
        } else {
          const state = await app.setReasoningEffort(
            selected === "default" ? undefined : selected,
          );
          terminal.write(`\n${renderReasoningEffortChanged(state)}\n`);
        }
      }
      break;
    }
    case "effort.changed":
      terminal.write(`\n${renderReasoningEffortChanged(result.state)}\n`);
      break;
    case "effort.not-found":
      terminal.write(
        `\nNo reasoning effort starts with: ` +
          `${sanitizeTerminalText(result.query)}\n`,
      );
      break;
    case "usage":
      terminal.write(`\nUsage: ${sanitizeTerminalText(result.usage)}\n`);
      break;
    case "unknown":
      terminal.write(
        `\nUnknown command: ${sanitizeTerminalText(result.command)}. ` +
          "Type /help.\n",
      );
      break;
  }
  return false;
}

function renderReasoningEffortState(
  state: MaybeCodeReasoningEffortState,
): string {
  if (state.status === "unknown") {
    return "Reasoning effort capability is unknown for the active model.";
  }
  if (state.status === "unsupported") {
    return "The active model does not support effort-based reasoning.";
  }
  const current = sanitizeTerminalText(
    state.effectiveEffort ?? "provider/model default",
  );
  return `Reasoning effort (source: ${sanitizeTerminalText(state.source)}, ` +
    `current: ${current})\n`;
}

function renderReasoningEffortChanged(
  state: MaybeCodeReasoningEffortState,
): string {
  const effort = sanitizeTerminalText(
    state.effectiveEffort ?? "provider/model default",
  );
  return `Reasoning effort: ${effort}${state.overridden ? " (runtime override)" : ""}`;
}

function renderSlashCommandHelp(
  commands: readonly MaybeCodeSlashCommand[],
): string {
  const entries = commands.map((command) => {
    const aliases = command.aliases === undefined
      ? ""
      : ` (alias ${command.aliases.join(", ")})`;
    return `  ${command.usage}${aliases}\n      ${command.description}`;
  }).join("\n");
  return `Commands:\n${entries}\n` +
    "  Ctrl+C\n      Cancel the active operation, or exit while idle\n" +
    "  Multiline\n      End a line with \\ to continue on the next line\n";
}

async function readInput(
  question: UIQuestion,
  suggestions: TerminalQuestionOptions["suggestions"],
): Promise<string> {
  const lines: string[] = [];
  while (true) {
    let line = await question(lines.length === 0 ? "\n> " : "... ", {
      history: false,
      ...(lines.length === 0 && suggestions !== undefined
        ? { suggestions }
        : {}),
    });
    if (lines.length === 0 && suggestions !== undefined) {
      const candidates = await suggestions(line);
      line = candidates[0]?.value ?? line;
    }
    const continuation = removeLineContinuation(line);
    lines.push(continuation.text);
    if (!continuation.continued) return lines.join("\n").trim();
  }
}

function removeLineContinuation(line: string): {
  readonly text: string;
  readonly continued: boolean;
} {
  let backslashes = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index--) {
    backslashes += 1;
  }
  if (backslashes % 2 === 0) return { text: line, continued: false };
  return { text: line.slice(0, -1), continued: true };
}

class TerminalRenderer {
  private textStarted = false;
  private reasoningStarted = false;
  private readonly changePreviews = new Map<string, ToolChangePreview>();
  private readonly toolOutputState = new Map<
    string,
    { endsWithNewline: boolean; channel?: string }
  >();

  constructor(private readonly terminal: TerminalIO) {}

  write(text: string): void {
    this.terminal.write(text);
  }

  runEvent(event: MayEvent): void {
    switch (event.type) {
      case "model.started":
        this.textStarted = false;
        this.reasoningStarted = false;
        break;
      case "model.reasoning.delta":
        if (!this.reasoningStarted) {
          this.terminal.write(`\n${this.dim("[thinking] ")}`);
          this.reasoningStarted = true;
        }
        this.terminal.write(this.dim(sanitizeTerminalText(event.delta)));
        break;
      case "model.text.delta":
        this.endReasoning();
        if (!this.textStarted) {
          this.terminal.write("\nMaybeCode: ");
          this.textStarted = true;
        }
        this.terminal.write(sanitizeTerminalText(event.delta));
        break;
      case "model.retrying":
        this.endReasoning();
        if (this.textStarted) this.terminal.write("\n");
        this.terminal.write(
          `\nModel request failed: ${sanitizeTerminalText(event.error.message)}. ` +
            `Retrying in ${formatDelay(event.delayMs)} ` +
            `(attempt ${event.attempt}/${event.maxAttempts})...\n`,
        );
        this.textStarted = false;
        this.reasoningStarted = false;
        break;
      case "model.completed": {
        this.endReasoning();
        const text = textFromContent(event.message.content);
        if (!this.textStarted && text !== "") {
          this.terminal.write(`\nMaybeCode: ${sanitizeTerminalText(text)}`);
          this.textStarted = true;
        }
        if (this.textStarted) this.terminal.write("\n");
        break;
      }
      case "tool.started":
        this.terminal.write(
          `\n→ ${sanitizeTerminalText(event.call.name)}${toolInputSummary(
            event.call.name,
            event.call.input,
          )}\n`,
        );
        break;
      case "tool.output.delta": {
        const key = toolCallKey(event.runId, event.call.id);
        const previous = this.toolOutputState.get(key);
        if (
          previous !== undefined &&
          !previous.endsWithNewline &&
          previous.channel !== event.channel
        ) {
          this.terminal.write("\n");
        }
        if (previous === undefined || previous.endsWithNewline ||
          previous.channel !== event.channel) {
          this.terminal.write(
            event.channel === undefined
              ? ""
              : `[${sanitizeTerminalText(event.channel)}] `,
          );
        }
        this.terminal.write(sanitizeTerminalText(event.delta));
        this.toolOutputState.set(key, {
          endsWithNewline: event.delta.endsWith("\n"),
          ...(event.channel === undefined ? {} : { channel: event.channel }),
        });
        break;
      }
      case "tool.progress":
        this.endToolOutput(event.runId, event.call.id);
        this.terminal.write(
          `↳ ${sanitizeTerminalText(event.call.name)}: ` +
            `${sanitizeTerminalText(event.message)}\n`,
        );
        break;
      case "tool.completed":
        this.endToolOutput(event.runId, event.call.id);
        this.renderToolCompleted(event);
        break;
      case "tool.failed":
        this.endToolOutput(event.runId, event.call.id);
        this.changePreviews.delete(toolCallKey(event.runId, event.call.id));
        this.terminal.write(
          `✗ ${sanitizeTerminalText(event.call.name)}: ` +
            `${sanitizeTerminalText(event.error.message)}\n`,
        );
        break;
      case "run.completed":
        this.clearRunPreviews(event.runId);
        break;
      case "run.failed":
        this.clearRunPreviews(event.runId);
        this.terminal.write(
          `\nRun failed: ${sanitizeTerminalText(event.error.message)}\n`,
        );
        break;
      case "run.cancelled":
        this.clearRunPreviews(event.runId);
        this.terminal.write(
          `\nRun cancelled${
            event.reason === undefined
              ? ""
              : `: ${sanitizeTerminalText(event.reason)}`
          }\n`,
        );
        break;
    }
  }

  changePreview(
    event: Extract<MaybeCodeEvent, { type: "change.preview" }>,
  ): void {
    this.changePreviews.set(
      toolCallKey(event.runId, event.toolCallId),
      event.preview,
    );
    if (event.preview.status === "unavailable") {
      this.terminal.write(
        `\nDiff unavailable for ${event.preview.tool} ` +
          `${sanitizeTerminalText(event.preview.path)}: ` +
          `${sanitizeTerminalText(event.preview.reason)}\n`,
      );
      return;
    }

    this.terminal.write(
      `\nChange preview: ${sanitizeTerminalText(event.preview.path)} ` +
        `(${changeKindLabel(event.preview.kind)})\n`,
    );
    this.terminal.write(
      event.preview.diff === ""
        ? "(no content changes)\n"
        : `${sanitizeTerminalText(event.preview.diff)}\n`,
    );
  }

  contextCompacted(
    event: Extract<MaybeCodeEvent, { type: "context.compacted" }>,
  ): void {
    const saved = Math.max(
      0,
      event.before.estimatedTokens - event.after.estimatedTokens,
    );
    this.terminal.write(
      `\nContext automatically compacted with ${event.strategy}: ` +
        `${event.before.messageCount} -> ${event.after.messageCount} messages, ` +
        `~${formatNumber(saved)} tokens saved.\n`,
    );
  }

  contextCompactionFailed(
    event: Extract<MaybeCodeEvent, { type: "context.compaction.failed" }>,
  ): void {
    const next = event.continuing
      ? " Trying the next strategy."
      : " No fallback strategies remain.";
    const message = sanitizeTerminalText(event.error.message)
      .replace(/[.!?]+$/u, "");
    this.terminal.write(
      `\nAutomatic context compaction failed with ${event.strategy} at ` +
        `~${formatNumber(event.before.effectiveTokens)} tokens: ` +
        `${message}.${next}\n`,
    );
  }

  permissionEvent(event: PermissionEvent): void {
    if (event.type === "approval.resolved") {
      this.terminal.write(`Permission: ${event.decision}\n`);
    } else if (event.type === "approval.cancelled") {
      this.terminal.write("Permission request cancelled.\n");
    }
  }

  approvalRequest(request: ApprovalRequest): void {
    const preview = this.changePreviews.get(
      toolCallKey(request.context.runId, request.context.toolCallId),
    );
    if (preview !== undefined) {
      this.terminal.write(
        `\nApproval required for ${sanitizeTerminalText(request.tool.name)}: ` +
          `${sanitizeTerminalText(preview.path)}\n`,
      );
      return;
    }
    this.terminal.write(
      `\nApproval required for ${sanitizeTerminalText(request.tool.name)}:\n` +
        `${sanitizeTerminalText(truncate(stringify(request.input), 1200))}\n`,
    );
  }

  async sessionChanged(
    event: Extract<MaybeCodeEvent, { type: "session.changed" }>,
    app: MaybeCodeController,
  ): Promise<void> {
    this.terminal.write(
      `\nSession ${event.resumed ? "resumed" : "started"}: ${event.sessionId}\n`,
    );
    if (!event.resumed) return;
    if (app.sessionId !== event.sessionId) return;
    renderHistory(await app.history(), this.terminal);
  }

  modelChanged(model: NonNullable<MaybeCodeController["modelInfo"]>): void {
    const profile = model.profile === undefined
      ? ""
      : ` ${sanitizeTerminalText(model.profile)}`;
    this.terminal.write(
      `\nModel switched to${profile}: ` +
        `${sanitizeTerminalText(model.provider)}/` +
        `${sanitizeTerminalText(model.model)}\n`,
    );
  }

  defaultModelChanged(profile: string): void {
    this.terminal.write(
      `\nDefault model set to ${sanitizeTerminalText(profile)}\n`,
    );
  }

  mcpEvent(
    event: Extract<MaybeCodeEvent, { type: `mcp.server.${string}` | `mcp.resource.${string}` }>,
  ): void {
    if (event.type === "mcp.resource.updated" || event.type === "mcp.resource.watch-closed") {
      this.terminal.write(`\n${sanitizeTerminalText(`${event.type}: ${event.serverId} ${event.uri}${event.type === "mcp.resource.watch-closed" ? ` (${event.reason})` : ""}`)}\n`);
      return;
    }
    if (event.type === "mcp.server.catalog-updated") {
      this.terminal.write(`\nMCP catalog updated: ${sanitizeTerminalText(event.serverId)} (revision ${event.revision})\n`);
      return;
    }
    if (event.type === "mcp.server.connected") {
      this.terminal.write(
        `\nMCP server connected: ${sanitizeTerminalText(event.serverId)} ` +
          `(${event.toolNames.length} tools)\n`,
      );
      return;
    }
    if (event.type === "mcp.server.failed") {
      this.terminal.write(
        `\nMCP server failed: ${sanitizeTerminalText(event.serverId)}: ` +
          `${sanitizeTerminalText(event.diagnostic.message)}\n`,
      );
      return;
    }
    this.terminal.write(
      `\nMCP server disconnected: ${sanitizeTerminalText(event.serverId)}\n`,
    );
  }

  private endReasoning(): void {
    if (!this.reasoningStarted) return;
    this.terminal.write(this.terminal.colors ? "\x1b[0m\n" : "\n");
    this.reasoningStarted = false;
  }

  private dim(text: string): string {
    return this.terminal.colors ? `\x1b[2m${text}\x1b[0m` : text;
  }

  private renderToolCompleted(
    event: Extract<MayEvent, { type: "tool.completed" }>,
  ): void {
    const key = toolCallKey(event.runId, event.call.id);
    const preview = this.changePreviews.get(key);
    this.changePreviews.delete(key);
    if (preview?.status === "ready") {
      this.terminal.write(
        `✓ ${sanitizeTerminalText(event.call.name)}: ` +
          `${sanitizeTerminalText(preview.path)} ` +
          `(${changeKindLabel(preview.kind)}, ` +
          `+${preview.additions} -${preview.deletions})\n`,
      );
      return;
    }
    this.terminal.write(
      `${toolResultMarker(event.output)} ${sanitizeTerminalText(event.call.name)}${
        toolResultSummary(event.output)
      }\n`,
    );
  }

  private clearRunPreviews(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.changePreviews.keys()) {
      if (key.startsWith(prefix)) this.changePreviews.delete(key);
    }
    for (const key of this.toolOutputState.keys()) {
      if (key.startsWith(prefix)) this.toolOutputState.delete(key);
    }
  }

  private endToolOutput(runId: string, toolCallId: string): void {
    const key = toolCallKey(runId, toolCallId);
    const state = this.toolOutputState.get(key);
    this.toolOutputState.delete(key);
    if (state?.endsWithNewline === false) this.terminal.write("\n");
  }
}

function renderHistory(
  history: readonly SessionEvent[],
  terminal: TerminalIO,
): void {
  for (const event of history) {
    if (event.type === "input.submitted") {
      const text = textFromContent(event.message.content);
      if (text !== "") terminal.write(`You: ${sanitizeTerminalText(text)}\n`);
    } else if (event.type === "assistant.completed") {
      const text = textFromContent(event.message.content);
      if (text !== "") {
        terminal.write(`MaybeCode: ${sanitizeTerminalText(text)}\n`);
      }
    } else if (event.type === "tool.completed") {
      terminal.write(
        `${toolResultMarker(event.output)} ${sanitizeTerminalText(event.call.name)}${
          toolResultSummary(event.output)
        }\n`,
      );
    } else if (event.type === "tool.failed") {
      terminal.write(
        `✗ ${sanitizeTerminalText(event.call.name)}: ` +
          `${sanitizeTerminalText(event.error.message)}\n`,
      );
    }
  }
}

function textFromContent(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toolResultSummary(output: unknown): string {
  if (typeof output !== "object" || output === null) return "";
  if ("path" in output && typeof output.path === "string") {
    return `: ${sanitizeTerminalText(output.path)}`;
  }
  if ("exitCode" in output && typeof output.exitCode === "number") {
    return `: exit ${output.exitCode}`;
  }
  return "";
}

function toolResultMarker(output: unknown): "✓" | "✗" {
  if (
    typeof output === "object" &&
    output !== null &&
    "exitCode" in output &&
    typeof output.exitCode === "number" &&
    output.exitCode !== 0
  ) {
    return "✗";
  }
  return "✓";
}

function permissionChoices(toolName: string): string {
  const scope = toolName === "shell" || toolName === "bash"
    ? "same command"
    : toolName === "edit" || toolName === "write"
    ? "same path"
    : "same operation";
  return `[a]llow once / allow ${scope} for [s]ession / [d]eny`;
}

function toolInputSummary(toolName: string, input: unknown): string {
  if (
    (toolName === "edit" || toolName === "write") &&
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    typeof input.path === "string"
  ) {
    return `: ${sanitizeTerminalText(input.path)}`;
  }
  return ` ${sanitizeTerminalText(truncate(stringify(input), 800))}`;
}

function toolCallKey(runId: string, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function renderInstructionSources(app: MaybeCodeController): string {
  const system = app.instructions.system.source;
  const runtime = app.instructions.runtime?.source;
  const project = app.instructions.project?.source;
  return `Instructions:\n  system: ${instructionSourceLabel(system)}\n` +
    `  runtime: ${
      runtime === undefined ? "none" : instructionSourceLabel(runtime)
    }\n` +
    `  project: ${
      project === undefined ? "none" : instructionSourceLabel(project)
    }\n`;
}

function renderStatus(
  app: MaybeCodeController,
  inspection: ContextInspection | undefined,
): string {
  let output = `Status:\n` +
    `  model: ${modelLabel(app)}\n` +
    `  session: ${sanitizeTerminalText(app.sessionId)}\n` +
    `  workspace: ${sanitizeTerminalText(app.workspace)}\n`;
  if (inspection === undefined) return `${output}  context: unavailable\n`;
  output += `  context: ~${formatNumber(inspection.effectiveTokens)}`;
  if (inspection.contextWindowTokens !== undefined) {
    output += ` / ${formatNumber(inspection.contextWindowTokens)} tokens ` +
      `(${((inspection.usageRatio ?? 0) * 100).toFixed(1)}%)`;
  } else {
    output += ` tokens (${inspection.measurementMethod})`;
  }
  return `${output}\n`;
}

function modelLabel(app: MaybeCodeController): string {
  if (app.modelInfo === undefined) return "custom";
  const endpoint = `${sanitizeTerminalText(app.modelInfo.provider)}/` +
    sanitizeTerminalText(app.modelInfo.model);
  return app.modelInfo.profile === undefined
    ? endpoint
    : `${sanitizeTerminalText(app.modelInfo.profile)} (${endpoint})`;
}

function renderContextInspection(inspection: ContextInspection): string {
  const roles = inspection.messagesByRole;
  let output = `Context:\n` +
    `  messages: ${inspection.messageCount} ` +
    `(system ${roles.system}, user ${roles.user}, ` +
    `assistant ${roles.assistant}, tool ${roles.tool})\n` +
    `  instructions: ${formatBytes(inspection.instructionsBytes)}\n` +
    `  message data: ${formatBytes(inspection.messageBytes)}\n` +
    `  total: ${formatBytes(inspection.totalBytes)}\n` +
    `  estimated tokens: ~${inspection.estimatedTokens} ` +
    `(${inspection.tokenEstimateMethod})\n`;
  if (inspection.contextWindowTokens === undefined) {
    output += `  effective usage: ~${formatNumber(inspection.effectiveTokens)} ` +
      `(${inspection.measurementMethod})\n`;
  } else {
    output += `  effective usage: ~${formatNumber(inspection.effectiveTokens)} / ` +
      `${formatNumber(inspection.contextWindowTokens)} ` +
      `(${((inspection.usageRatio ?? 0) * 100).toFixed(1)}%)\n`;
  }
  if (inspection.measurementMethod === "measured+estimated") {
    output += `  measurement: ${formatNumber(
      inspection.measuredInputTokens ?? 0,
    )} measured + ~${formatNumber(
      inspection.estimatedTailTokens ?? 0,
    )} estimated tail\n`;
  } else {
    output += "  measurement: estimated only\n";
  }
  if (inspection.remainingTokens !== undefined) {
    output += `  remaining: ${formatNumber(inspection.remainingTokens)} tokens\n`;
  }
  if (inspection.inputBudgetTokens !== undefined) {
    output += `  input budget: ${formatNumber(inspection.inputBudgetTokens)} tokens`;
    if ((inspection.reservedTokens ?? 0) > 0) {
      output += ` (${formatNumber(inspection.reservedTokens ?? 0)} reserved)`;
    }
    output += "\n";
  }
  if (inspection.compactTriggerTokens !== undefined) {
    output += `  compaction threshold: ${formatNumber(
      inspection.compactTriggerTokens,
    )} tokens (${inspection.shouldCompact === true ? "reached" : "not reached"})\n`;
  }
  return output;
}

function renderCompactionResult(
  result: Awaited<ReturnType<MaybeCodeController["compactContext"]>>,
): string {
  if (!result.changed) {
    return `No context changes were eligible for ${result.strategy}.\n`;
  }
  const saved = Math.max(
    0,
    result.before.estimatedTokens - result.after.estimatedTokens,
  );
  const ratio = result.before.estimatedTokens === 0
    ? 0
    : saved / result.before.estimatedTokens * 100;
  return `Context compacted with ${result.strategy}:\n` +
    `  messages: ${result.before.messageCount} -> ${result.after.messageCount}\n` +
    `  estimated tokens: ~${formatNumber(result.before.estimatedTokens)} -> ` +
    `~${formatNumber(result.after.estimatedTokens)}\n` +
    `  saved: ~${formatNumber(saved)} tokens (${ratio.toFixed(1)}%)\n`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDelay(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function instructionSourceLabel(
  source: MaybeCodeController["instructions"]["system"]["source"],
): string {
  return source.type === "file" ? source.path : source.type;
}

function changeKindLabel(kind: FileChangeKind): string {
  switch (kind) {
    case "create":
      return "created";
    case "update":
      return "updated";
    case "no-change":
      return "unchanged";
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "RunCancelledError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
