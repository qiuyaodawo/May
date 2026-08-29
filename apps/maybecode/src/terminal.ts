import { clearLine, cursorTo, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";

export interface TerminalQuestionOptions {
  readonly signal?: AbortSignal;
  /** Keep this answer in interactive input history. */
  readonly history?: boolean;
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
  readonly output?: NodeJS.WritableStream & { readonly isTTY?: boolean };
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
      try {
        return await (questionOptions.signal === undefined
          ? readline.question(prompt)
          : readline.question(prompt, { signal: questionOptions.signal }));
      } finally {
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
    },
    onInterrupt(listener) {
      readline.on("SIGINT", listener);
      return () => readline.off("SIGINT", listener);
    },
    close() {
      readline.close();
    },
  };
}
