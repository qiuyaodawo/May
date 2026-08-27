import type { ContentPart, MayEvent } from "@may/core";
import type { ApprovalRequest, PermissionEvent } from "@may/permissions";
import type { SessionEvent } from "@may/session";

import type { MaybeCodeEvent } from "./events.js";
import type { MaybeCodeTerminal } from "./terminal.js";
import { createNodeTerminal } from "./terminal.js";
import type { MaybeCodeWorkspace } from "./workspace.js";

const HELP = `Commands:
  /new             Start a new session
  /sessions        List sessions for this workspace
  /resume <id>     Switch to another session
  /help            Show commands
  /quit             Exit MaybeCode
  Ctrl+C            Cancel the active run, or exit while idle
`;

export interface RunTerminalUIOptions {
  readonly terminal?: MaybeCodeTerminal;
}

export async function runTerminalUI(
  app: MaybeCodeWorkspace,
  options: RunTerminalUIOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? createNodeTerminal();
  const renderer = new TerminalRenderer(terminal);
  let activeQuestion: AbortController | undefined;
  let exit = false;

  const question = async (prompt: string): Promise<string> => {
    const controller = new AbortController();
    activeQuestion = controller;
    try {
      return await terminal.question(prompt, { signal: controller.signal });
    } finally {
      if (activeQuestion === controller) activeQuestion = undefined;
    }
  };

  const removeInterrupt = terminal.onInterrupt?.(() => {
    if (app.isRunning) {
      terminal.write("\nCancelling current run...\n");
      app.cancel("Interrupted");
      activeQuestion?.abort();
    } else {
      exit = true;
      activeQuestion?.abort();
    }
  });

  const eventTask = consumeEvents(app, renderer, question);
  terminal.write(
    `MaybeCode\nWorkspace: ${app.workspace}\nType /help for commands.\n`,
  );

  try {
    while (!exit) {
      let input: string;
      try {
        input = (await question("\n> ")).trim();
      } catch (error) {
        if (isAbortError(error)) {
          if (!app.isRunning) break;
          continue;
        }
        throw error;
      }

      if (input === "") continue;
      if (input.startsWith("/")) {
        try {
          exit = await handleCommand(input, app, terminal);
        } catch (error) {
          terminal.write(`\nError: ${errorMessage(error)}\n`);
        }
        continue;
      }

      try {
        const run = await app.submit({ input });
        await run.result;
      } catch (error) {
        if (!isCancellation(error)) {
          terminal.write(`\nError: ${errorMessage(error)}\n`);
        }
      }
    }
  } finally {
    activeQuestion?.abort();
    removeInterrupt?.();
    await app.close();
    await eventTask;
    terminal.close();
  }
}

async function consumeEvents(
  app: MaybeCodeWorkspace,
  renderer: TerminalRenderer,
  question: (prompt: string) => Promise<string>,
): Promise<void> {
  for await (const event of app.events) {
    if (event.type === "run.event") {
      renderer.runEvent(event.event);
    } else if (event.type === "permission.event") {
      await handlePermissionEvent(event.event, app, renderer, question);
    } else {
      await renderer.sessionChanged(event, app);
    }
  }
}

async function handlePermissionEvent(
  event: PermissionEvent,
  app: MaybeCodeWorkspace,
  renderer: TerminalRenderer,
  question: (prompt: string) => Promise<string>,
): Promise<void> {
  if (event.type !== "approval.requested") {
    renderer.permissionEvent(event);
    return;
  }

  renderer.approvalRequest(event.request);
  while (true) {
    const choices = event.request.grantKey === undefined
      ? "[a]llow once / [d]eny"
      : "[a]llow once / allow [s]ession / [d]eny";
    let answer: string;
    try {
      answer = (await question(`${choices}: `)).trim().toLowerCase();
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
  app: MaybeCodeWorkspace,
  terminal: MaybeCodeTerminal,
): Promise<boolean> {
  const [command, ...arguments_] = input.split(/\s+/u);
  switch (command) {
    case "/quit":
    case "/exit":
      return true;
    case "/help":
      terminal.write(`\n${HELP}`);
      return false;
    case "/new": {
      const id = await app.newSession();
      terminal.write(`\nCreated session ${id}\n`);
      return false;
    }
    case "/sessions": {
      const sessions = await app.listSessions();
      terminal.write("\nSessions:\n");
      for (const session of sessions) {
        const marker = session.id === app.sessionId ? "*" : " ";
        terminal.write(
          `${marker} ${session.id}  ${new Date(session.lastUsedAt).toISOString()}\n`,
        );
      }
      return false;
    }
    case "/resume": {
      const id = arguments_[0];
      if (id === undefined) {
        terminal.write("\nUsage: /resume <session-id>\n");
        return false;
      }
      await app.resumeSession(id);
      terminal.write(`\nResumed session ${id}\n`);
      return false;
    }
    default:
      terminal.write(`\nUnknown command: ${command}. Type /help.\n`);
      return false;
  }
}

class TerminalRenderer {
  private textStarted = false;
  private reasoningStarted = false;

  constructor(private readonly terminal: MaybeCodeTerminal) {}

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
        this.terminal.write(this.dim(event.delta));
        break;
      case "model.text.delta":
        this.endReasoning();
        if (!this.textStarted) {
          this.terminal.write("\nMay: ");
          this.textStarted = true;
        }
        this.terminal.write(event.delta);
        break;
      case "model.completed": {
        this.endReasoning();
        const text = textFromContent(event.message.content);
        if (!this.textStarted && text !== "") {
          this.terminal.write(`\nMay: ${text}`);
          this.textStarted = true;
        }
        if (this.textStarted) this.terminal.write("\n");
        break;
      }
      case "tool.started":
        this.terminal.write(
          `\n→ ${event.call.name} ${truncate(stringify(event.call.input), 800)}\n`,
        );
        break;
      case "tool.completed":
        this.terminal.write(
          `✓ ${event.call.name}${toolResultSummary(event.output)}\n`,
        );
        break;
      case "tool.failed":
        this.terminal.write(
          `✗ ${event.call.name}: ${event.error.message}\n`,
        );
        break;
      case "run.failed":
        this.terminal.write(`\nRun failed: ${event.error.message}\n`);
        break;
      case "run.cancelled":
        this.terminal.write(
          `\nRun cancelled${event.reason === undefined ? "" : `: ${event.reason}`}\n`,
        );
        break;
    }
  }

  permissionEvent(event: PermissionEvent): void {
    if (event.type === "approval.resolved") {
      this.terminal.write(`Permission: ${event.decision}\n`);
    } else if (event.type === "approval.cancelled") {
      this.terminal.write("Permission request cancelled.\n");
    }
  }

  approvalRequest(request: ApprovalRequest): void {
    this.terminal.write(
      `\nApproval required for ${request.tool.name}:\n${truncate(stringify(request.input), 1200)}\n`,
    );
  }

  async sessionChanged(
    event: Extract<MaybeCodeEvent, { type: "session.changed" }>,
    app: MaybeCodeWorkspace,
  ): Promise<void> {
    this.terminal.write(
      `\nSession ${event.resumed ? "resumed" : "started"}: ${event.sessionId}\n`,
    );
    if (!event.resumed) return;
    if (app.sessionId !== event.sessionId) return;
    renderHistory(await app.history(), this.terminal);
  }

  private endReasoning(): void {
    if (!this.reasoningStarted) return;
    this.terminal.write(this.terminal.colors ? "\x1b[0m\n" : "\n");
    this.reasoningStarted = false;
  }

  private dim(text: string): string {
    return this.terminal.colors ? `\x1b[2m${text}\x1b[0m` : text;
  }
}

function renderHistory(
  history: readonly SessionEvent[],
  terminal: MaybeCodeTerminal,
): void {
  for (const event of history) {
    if (event.type === "input.submitted") {
      const text = textFromContent(event.message.content);
      if (text !== "") terminal.write(`You: ${text}\n`);
    } else if (event.type === "assistant.completed") {
      const text = textFromContent(event.message.content);
      if (text !== "") terminal.write(`May: ${text}\n`);
    } else if (event.type === "tool.completed") {
      terminal.write(`✓ ${event.call.name}${toolResultSummary(event.output)}\n`);
    } else if (event.type === "tool.failed") {
      terminal.write(`✗ ${event.call.name}: ${event.error.message}\n`);
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
    return `: ${output.path}`;
  }
  if ("exitCode" in output && typeof output.exitCode === "number") {
    return `: exit ${output.exitCode}`;
  }
  return "";
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
