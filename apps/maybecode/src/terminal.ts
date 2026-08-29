import { clearLine, cursorTo, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";

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

/** Low-level I/O adapter used by the bundled TUI, not the custom-UI contract. */
export interface MaybeCodeTerminal {
  readonly colors?: boolean;
  question(prompt: string, options?: TerminalQuestionOptions): Promise<string>;
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

export function createNodeTerminal(
  options: NodeTerminalOptions = {},
): MaybeCodeTerminal {
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
  });
  const history = (readline as unknown as { readonly history: string[] }).history;
  let activePrompt: string | undefined;
  let activeSuggestionProvider: TerminalSuggestionProvider | undefined;
  let activeSuggestions: readonly TerminalSuggestion[] = [];
  let renderedSuggestionCount = 0;
  let suggestionVersion = 0;

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
  ): void => {
    eraseSuggestionRows();
    activeSuggestions = suggestions;
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
    replaceSuggestions(suggestions);
  };

  const onKeypress = (
    _value: string | undefined,
    key: { readonly name?: string; readonly ctrl?: boolean } = {},
  ): void => {
    if (activePrompt === undefined) return;
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
    async question(prompt, questionOptions = {}) {
      if (activePrompt !== undefined) {
        throw new Error("The terminal already has an active question");
      }
      const previousHistory = questionOptions.history === false
        ? [...history]
        : undefined;
      activePrompt = prompt;
      activeSuggestionProvider = questionOptions.suggestions;
      activeSuggestions = [];
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
        activePrompt = undefined;
        if (previousHistory !== undefined) {
          history.splice(0, history.length, ...previousHistory);
        }
      }
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
      readline.on("SIGINT", listener);
      return () => readline.off("SIGINT", listener);
    },
    close() {
      if (interactive) input.removeListener("keypress", onKeypress);
      readline.close();
    },
  };
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
