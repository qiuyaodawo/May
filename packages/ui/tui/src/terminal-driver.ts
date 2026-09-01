import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { keyStroke, type KeyStroke } from "@may/keybindings";
import type { RenderSize } from "./component.js";
import type { TerminalWriter } from "./renderer.js";

export interface TerminalInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(enabled: boolean): this;
  ref?(): this;
  unref?(): this;
}

export interface TerminalOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface NodeTerminalDriverOptions {
  readonly input?: TerminalInput;
  readonly output?: TerminalOutput;
  readonly requireTTY?: boolean;
}

type KeyListener = (stroke: KeyStroke) => void;
type ResizeListener = (size: RenderSize) => void;

const BRACKETED_PASTE_START = Buffer.from("\x1b[200~");
const BRACKETED_PASTE_END = Buffer.from("\x1b[201~");
const ESCAPE_PREFIX_TIMEOUT_MS = 25;

export class NodeTerminalDriver implements TerminalWriter {
  private readonly input: TerminalInput;
  private readonly output: TerminalOutput;
  private readonly requireTTY: boolean;
  private readonly decodedInput = new PassThrough();
  private readonly inputDecoder = new BracketedPasteDecoder(
    (value) => this.decodedInput.write(value),
    (value) => this.emitPaste(value),
  );
  private readonly keyListeners = new Set<KeyListener>();
  private readonly resizeListeners = new Set<ResizeListener>();
  private started = false;
  private alternateScreen = false;
  private previousRawMode = false;
  private inputWasPaused = true;
  private keypressInitialized = false;
  private bracketedPaste = false;

  constructor(options: NodeTerminalDriverOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.requireTTY = options.requireTTY ?? true;
  }

  get size(): RenderSize {
    return {
      width: Math.max(1, this.output.columns ?? 80),
      height: Math.max(1, this.output.rows ?? 24),
    };
  }

  start(): void {
    if (this.started) return;
    if (this.requireTTY &&
      (this.input.isTTY !== true || this.output.isTTY !== true)) {
      throw new Error("The TUI requires an interactive terminal");
    }
    this.previousRawMode = this.input.isRaw === true;
    this.inputWasPaused = this.input.isPaused();
    if (!this.keypressInitialized) {
      emitKeypressEvents(this.decodedInput);
      this.keypressInitialized = true;
    }
    this.inputDecoder.reset();
    this.decodedInput.on("keypress", this.handleKeypress);
    this.input.on("data", this.handleData);
    this.output.on("resize", this.handleResize);
    this.input.ref?.();
    this.input.setRawMode?.(true);
    this.input.resume();
    this.write("\x1b[?2004h");
    this.bracketedPaste = true;
    this.started = true;
  }

  enterAlternateScreen(): void {
    if (this.alternateScreen) return;
    this.write("\x1b[?1049h\x1b[2J\x1b[H");
    this.alternateScreen = true;
  }

  leaveAlternateScreen(): void {
    if (!this.alternateScreen) return;
    this.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    this.alternateScreen = false;
  }

  onKey(listener: KeyListener): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  onResize(listener: ResizeListener): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  write(value: string): void {
    this.output.write(value);
  }

  close(): void {
    if (this.bracketedPaste) {
      this.write("\x1b[?2004l");
      this.bracketedPaste = false;
    }
    if (this.alternateScreen) this.leaveAlternateScreen();
    if (!this.started) return;
    this.inputDecoder.reset();
    this.input.removeListener("data", this.handleData);
    this.decodedInput.removeListener("keypress", this.handleKeypress);
    this.output.removeListener("resize", this.handleResize);
    this.input.setRawMode?.(this.previousRawMode);
    if (this.inputWasPaused) this.input.pause();
    this.input.unref?.();
    this.started = false;
  }

  private readonly handleKeypress = (
    value: string | undefined,
    key: NodeKey = {},
  ): void => {
    const stroke = toKeyStroke(value, key);
    for (const listener of this.keyListeners) listener(stroke);
  };

  private readonly handleData = (value: Buffer | string): void => {
    this.inputDecoder.push(value);
  };

  private readonly handleResize = (): void => {
    const size = this.size;
    for (const listener of this.resizeListeners) listener(size);
  };

  private emitPaste(value: string): void {
    if (value === "") return;
    const stroke = keyStroke("paste", { text: value });
    for (const listener of this.keyListeners) listener(stroke);
  }
}

interface NodeKey {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

function toKeyStroke(value: string | undefined, key: NodeKey): KeyStroke {
  const name = key.name ?? value ?? "unknown";
  const printable = value !== undefined && value.length > 0 &&
    key.ctrl !== true && key.meta !== true;
  return keyStroke(name, {
    ctrl: key.ctrl === true,
    alt: key.meta === true && name !== "escape",
    shift: key.shift === true,
    ...(printable ? { text: value } : {}),
  });
}

class BracketedPasteDecoder {
  private pending = Buffer.alloc(0);
  private paste = false;
  private prefixTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onInput: (value: Buffer) => void,
    private readonly onPaste: (value: string) => void,
  ) {}

  push(value: Buffer | string): void {
    this.clearPrefixTimer();
    const incoming = Buffer.from(value);
    this.pending = this.pending.length === 0
      ? incoming
      : Buffer.concat([this.pending, incoming]);
    this.process();
  }

  reset(): void {
    this.clearPrefixTimer();
    this.pending = Buffer.alloc(0);
    this.paste = false;
  }

  private process(): void {
    while (this.pending.length > 0) {
      const marker = this.paste
        ? BRACKETED_PASTE_END
        : BRACKETED_PASTE_START;
      const markerIndex = this.pending.indexOf(marker);
      if (markerIndex >= 0) {
        this.emit(this.pending.subarray(0, markerIndex));
        this.pending = this.pending.subarray(markerIndex + marker.length);
        this.paste = !this.paste;
        continue;
      }

      if (this.paste) return;
      const retained = markerPrefixLength(this.pending, marker);
      const inputEnd = this.pending.length - retained;
      if (inputEnd > 0) this.onInput(this.pending.subarray(0, inputEnd));
      this.pending = this.pending.subarray(inputEnd);
      if (this.pending.length > 0) this.schedulePrefixFlush();
      return;
    }
  }

  private emit(value: Buffer): void {
    if (value.length === 0) return;
    if (this.paste) this.onPaste(value.toString("utf8"));
    else this.onInput(value);
  }

  private schedulePrefixFlush(): void {
    this.prefixTimer = setTimeout(() => {
      this.prefixTimer = undefined;
      const pending = this.pending;
      this.pending = Buffer.alloc(0);
      if (pending.length > 0) this.onInput(pending);
    }, ESCAPE_PREFIX_TIMEOUT_MS);
    this.prefixTimer.unref?.();
  }

  private clearPrefixTimer(): void {
    if (this.prefixTimer !== undefined) clearTimeout(this.prefixTimer);
    this.prefixTimer = undefined;
  }
}

function markerPrefixLength(value: Buffer, marker: Buffer): number {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length--) {
    if (value.subarray(value.length - length).equals(marker.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}
