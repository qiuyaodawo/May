import { createInterface } from "node:readline/promises";

export interface TerminalQuestionOptions {
  readonly signal?: AbortSignal;
}

export interface MaybeCodeTerminal {
  readonly colors?: boolean;
  question(prompt: string, options?: TerminalQuestionOptions): Promise<string>;
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
  const readline = createInterface({
    input,
    output,
    terminal: output.isTTY === true,
  });

  return {
    colors: options.colors ?? output.isTTY === true,
    question(prompt, questionOptions = {}) {
      return questionOptions.signal === undefined
        ? readline.question(prompt)
        : readline.question(prompt, { signal: questionOptions.signal });
    },
    write(text) {
      output.write(text);
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
