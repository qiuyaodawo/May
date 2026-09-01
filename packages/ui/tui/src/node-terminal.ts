import { clearLine, cursorTo, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";
import { keyStroke, type KeyStroke } from "@may/keybindings";

export interface TerminalSuggestion {
  /** Full input value represented by the suggestion. */
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export type TerminalSuggestionProvider = (
  input: string,
) =>
  | readonly TerminalSuggestion[]
  | Promise<readonly TerminalSuggestion[]>;

export interface TerminalQuestionOptions {
  readonly signal?: AbortSignal;
  /** Keep this answer in interactive input history. */
  readonly history?: boolean;
  /** Live suggestions displayed while editing this answer in an interactive TTY. */
  readonly suggestions?: TerminalSuggestionProvider;
}

/**
 * Line-oriented terminal I/O used by prompt-driven applications.
 *
 * This is separate from {@link NodeTerminalDriver}, which owns raw input and
 * retained full-screen rendering.
 */
export interface TerminalIO {
  readonly colors?: boolean;
  readonly interactive?: boolean;
  question(prompt: string, options?: TerminalQuestionOptions): Promise<string>;
  /** Read one normalized key while no line question is active. */
  readKey?(options?: { readonly signal?: AbortSignal }): Promise<KeyStroke>;
  /** Render a temporary full-screen view. */
  renderView?(text: string): void;
  /** Close the temporary view and restore the previous terminal contents. */
  closeView?(): void;
  addHistory?(value: string): void;
  write(text: string): void;
  onInterrupt?(listener: () => void): () => void;
  close(): void;
}

export interface NodeTerminalOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream & {
    readonly isTTY?: boolean;
    readonly columns?: number;
  };
  readonly colors?: boolean;
}

/** Create a readline-backed, line-oriented Node terminal adapter. */
export function createNodeTerminal(
  options: NodeTerminalOptions = {},
): TerminalIO {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = output.isTTY === true;
  const historySize = 200;
  const readline = createInterface({
    input,
    output,
    terminal: interactive,
    historySize,
    removeHistoryDuplicates: true,
    escapeCodeTimeout: 100,
  });
  const history = (readline as unknown as { readonly history: string[] }).history;
  let activePrompt: string | undefined;
  let activeSuggestionProvider: TerminalSuggestionProvider | undefined;
  let activeSuggestions: readonly TerminalSuggestion[] = [];
  let renderedSuggestionCount = 0;
  let suggestionVersion = 0;
  let activeSuggestionInput: string | undefined;
  let activeKeyRead: KeyRead | undefined;
  let viewActive = false;
  let suppressInterrupt = false;
  let closed = false;

  const inputColumn = (): number => {
    const prompt = activePrompt?.replace(/^\r?\n/u, "") ?? "";
    return prompt.length + readline.cursor;
  };

  const eraseSuggestionRows = (): void => {
    if (!interactive || renderedSuggestionCount === 0) return;
    for (let index = 0; index < renderedSuggestionCount; index++) {
      moveCursor(output, 0, 1);
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    moveCursor(output, 0, -renderedSuggestionCount);
    cursorTo(output, inputColumn());
    renderedSuggestionCount = 0;
  };

  const drawSuggestionRows = (): void => {
    if (!interactive || activePrompt === undefined || activeSuggestions.length === 0) {
      return;
    }
    const suggestions = activeSuggestions.slice(0, 8);
    for (const suggestion of suggestions) {
      output.write(`\n${formatSuggestion(suggestion, output.columns)}`);
    }
    renderedSuggestionCount = suggestions.length;
    moveCursor(output, 0, -renderedSuggestionCount);
    cursorTo(output, inputColumn());
  };

  const replaceSuggestions = (
    suggestions: readonly TerminalSuggestion[],
    inputValue: string,
  ): void => {
    eraseSuggestionRows();
    activeSuggestions = suggestions;
    activeSuggestionInput = inputValue;
    drawSuggestionRows();
  };

  const refreshSuggestions = async (): Promise<void> => {
    const provider = activeSuggestionProvider;
    if (!interactive || activePrompt === undefined || provider === undefined) {
      return;
    }
    const line = readline.line;
    const version = ++suggestionVersion;
    let suggestions: readonly TerminalSuggestion[];
    try {
      suggestions = await provider(line);
    } catch {
      suggestions = [];
    }
    if (
      version !== suggestionVersion ||
      provider !== activeSuggestionProvider ||
      activePrompt === undefined ||
      line !== readline.line
    ) {
      return;
    }
    replaceSuggestions(suggestions, line);
  };

  const completeActiveSuggestion = (line: string): boolean => {
    if (activeSuggestionInput !== line) return false;
    const completion = commonSuggestionPrefix(line, activeSuggestions);
    if (completion === undefined || completion === line) return false;
    suggestionVersion += 1;
    eraseSuggestionRows();
    activeSuggestions = [];
    activeSuggestionInput = undefined;
    readline.write(undefined, { ctrl: true, name: "u" });
    readline.write(completion);
    return true;
  };

  const onKeypress = (
    value: string | undefined,
    key: NodeKey = {},
  ): void => {
    if (activeKeyRead !== undefined) {
      const read = activeKeyRead;
      activeKeyRead = undefined;
      read.cleanup();
      if (key.ctrl === true && key.name === "c") {
        suppressInterrupt = true;
        setImmediate(() => suppressInterrupt = false);
      }
      read.resolve(toKeyStroke(value, key));
      queueMicrotask(() => {
        if (!closed && activePrompt === undefined) {
          readline.write(undefined, { ctrl: true, name: "u" });
        }
      });
      return;
    }
    if (activePrompt === undefined) return;
    if (key.name === "tab" && activeSuggestionProvider !== undefined) {
      const line = readline.line;
      const completed = completeActiveSuggestion(line);
      const expected = readline.line;
      queueMicrotask(() => {
        if (readline.line === `${expected}\t`) {
          readline.write(undefined, { ctrl: true, name: "u" });
          readline.write(expected);
        }
        void refreshSuggestions().then(() => {
          if (
            !completed && activePrompt !== undefined &&
            readline.line === line
          ) {
            completeActiveSuggestion(line);
          }
        });
      });
      return;
    }
    if (
      key.name === "return" ||
      key.name === "enter" ||
      (key.ctrl === true && key.name === "c")
    ) {
      suggestionVersion += 1;
      eraseSuggestionRows();
      activeSuggestions = [];
      return;
    }
    queueMicrotask(() => void refreshSuggestions());
  };
  if (interactive) input.prependListener("keypress", onKeypress);

  return {
    colors: options.colors ?? interactive,
    interactive,
    async question(prompt, questionOptions = {}) {
      if (activePrompt !== undefined) {
        throw new Error("The terminal already has an active question");
      }
      if (activeKeyRead !== undefined) {
        throw new Error("The terminal is currently reading a key");
      }
      const previousHistory = questionOptions.history === false
        ? [...history]
        : undefined;
      activePrompt = prompt;
      activeSuggestionProvider = questionOptions.suggestions;
      activeSuggestions = [];
      activeSuggestionInput = undefined;
      renderedSuggestionCount = 0;
      suggestionVersion += 1;
      try {
        return await (questionOptions.signal === undefined
          ? readline.question(prompt)
          : readline.question(prompt, { signal: questionOptions.signal }));
      } finally {
        suggestionVersion += 1;
        eraseSuggestionRows();
        activeSuggestionProvider = undefined;
        activeSuggestions = [];
        activeSuggestionInput = undefined;
        activePrompt = undefined;
        if (previousHistory !== undefined) {
          history.splice(0, history.length, ...previousHistory);
        }
      }
    },
    readKey({ signal } = {}) {
      if (!interactive) {
        return Promise.reject(
          new Error("Key input requires an interactive terminal"),
        );
      }
      if (activePrompt !== undefined || activeKeyRead !== undefined) {
        return Promise.reject(new Error("The terminal input is already active"));
      }
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      return new Promise<KeyStroke>((resolve, reject) => {
        const onAbort = () => {
          if (activeKeyRead !== read) return;
          activeKeyRead = undefined;
          read.cleanup();
          reject(abortError(signal?.reason));
        };
        const read: KeyRead = {
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", onAbort),
        };
        activeKeyRead = read;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    renderView(text) {
      if (!interactive) {
        output.write(text);
        return;
      }
      if (!viewActive) {
        output.write("\x1b[?1049h");
        viewActive = true;
      }
      output.write(`\x1b[2J\x1b[H${text}`);
    },
    closeView() {
      if (!viewActive) return;
      output.write("\x1b[?1049l");
      viewActive = false;
    },
    addHistory(value) {
      if (!interactive) return;
      const entry = value.replace(/\r?\n/gu, " ").trim();
      if (entry === "") return;
      const existing = history.indexOf(entry);
      if (existing >= 0) history.splice(existing, 1);
      history.unshift(entry);
      if (history.length > historySize) {
        history.splice(historySize);
      }
    },
    write(text) {
      if (!interactive || activePrompt === undefined) {
        output.write(text);
        return;
      }

      eraseSuggestionRows();
      const line = readline.line;
      const position = readline.cursor;
      clearLine(output, 0);
      cursorTo(output, 0);
      const update = text.replace(/^\r?\n/u, "");
      output.write(update);
      if (update !== "" && !update.endsWith("\n")) output.write("\n");
      output.write(`${activePrompt.replace(/^\r?\n/u, "")}${line}`);
      const trailing = line.length - position;
      if (trailing > 0) moveCursor(output, -trailing, 0);
      drawSuggestionRows();
    },
    onInterrupt(listener) {
      const wrapped = () => {
        if (suppressInterrupt) {
          suppressInterrupt = false;
          return;
        }
        listener();
      };
      readline.on("SIGINT", wrapped);
      return () => readline.off("SIGINT", wrapped);
    },
    close() {
      closed = true;
      activeKeyRead?.reject(new Error("Terminal closed"));
      activeKeyRead?.cleanup();
      activeKeyRead = undefined;
      if (viewActive) output.write("\x1b[?1049l");
      if (interactive) input.removeListener("keypress", onKeypress);
      readline.close();
    },
  };
}

interface NodeKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

interface KeyRead {
  readonly resolve: (stroke: KeyStroke) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

function toKeyStroke(value: string | undefined, key: NodeKey): KeyStroke {
  const name = key.name ?? value ?? "unknown";
  const standaloneEscape = name === "escape";
  const printable = value !== undefined && value.length > 0 &&
    key.ctrl !== true && key.meta !== true;
  return keyStroke(name, {
    ctrl: key.ctrl === true,
    alt: key.meta === true && !standaloneEscape,
    shift: key.shift === true,
    ...(printable ? { text: value } : {}),
  });
}

function commonSuggestionPrefix(
  input: string,
  suggestions: readonly TerminalSuggestion[],
): string | undefined {
  const values = suggestions
    .map((suggestion) => suggestion.value)
    .filter((value) => value.startsWith(input));
  const first = values[0];
  if (first === undefined) return undefined;
  let length = first.length;
  for (const value of values.slice(1)) {
    length = Math.min(length, value.length);
    let index = input.length;
    while (index < length && first[index] === value[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === "string" ? reason : "The operation was aborted",
  );
  error.name = "AbortError";
  return error;
}

function formatSuggestion(
  suggestion: TerminalSuggestion,
  columns: number | undefined,
): string {
  const label = singleLine(suggestion.label ?? suggestion.value);
  const description = suggestion.description === undefined
    ? ""
    : `  ${singleLine(suggestion.description)}`;
  const value = `  ${label}${description}`;
  const limit = columns === undefined ? 120 : Math.max(20, columns - 1);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
