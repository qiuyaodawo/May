import clipboardy from "clipboardy";
import type { TerminalWriter } from "./renderer.js";

export interface Clipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export type ClipboardMode = "auto" | "system" | "osc52" | "disabled";

export interface TerminalClipboardOptions {
  readonly mode?: ClipboardMode;
  readonly output?: TerminalWriter;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class ClipboardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipboardUnavailableError";
  }
}

export class SystemClipboard implements Clipboard {
  async readText(): Promise<string> {
    return clipboardy.read();
  }

  async writeText(text: string): Promise<void> {
    await clipboardy.write(text);
  }
}

export class Osc52Clipboard implements Clipboard {
  constructor(private readonly output: TerminalWriter) {}

  async readText(): Promise<string> {
    throw new ClipboardUnavailableError("OSC 52 clipboard reads are unavailable. Use your terminal's paste command.");
  }

  async writeText(text: string): Promise<void> {
    this.output.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  }
}

class UnavailableClipboard implements Clipboard {
  constructor(private readonly reason: string) {}

  async readText(): Promise<string> {
    throw new ClipboardUnavailableError(this.reason);
  }

  async writeText(_text: string): Promise<void> {
    throw new ClipboardUnavailableError(this.reason);
  }
}

export function createTerminalClipboard(options: TerminalClipboardOptions = {}): Clipboard {
  const env = options.env ?? process.env;
  const mode = options.mode ?? env.MAY_CLIPBOARD ?? "auto";
  switch (mode) {
    case "system": return new SystemClipboard();
    case "osc52": return new Osc52Clipboard(options.output ?? process.stdout);
    case "disabled": return new UnavailableClipboard("Clipboard access is disabled by MAY_CLIPBOARD.");
    case "auto":
      if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
        return new UnavailableClipboard(
          "Remote clipboard access requires MAY_CLIPBOARD=osc52 and a terminal that permits OSC 52. Use your terminal's paste command to paste.",
        );
      }
      return new SystemClipboard();
    default: throw new RangeError(`Unsupported MAY_CLIPBOARD value: ${mode}. Expected auto, system, osc52, or disabled.`);
  }
}
