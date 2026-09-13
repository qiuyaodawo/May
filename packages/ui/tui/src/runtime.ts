import type { KeyStroke } from "@may/keybindings";
import type {
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "./component.js";
import type { TerminalWriter } from "./renderer.js";

export interface RuntimeTerminal extends TerminalWriter {
  readonly size: RenderSize;
  start(): void;
  close(): void;
  enterAlternateScreen?(): void;
  onKey(listener: (stroke: KeyStroke) => void): () => void;
  onResize(listener: (size: RenderSize) => void): () => void;
}

export interface RuntimeRenderer {
  render(result: RenderResult, size: RenderSize): void;
  invalidate(): void;
  dispose(options?: { readonly clear?: boolean }): void;
}

export interface TuiRuntimeOptions {
  readonly terminal: RuntimeTerminal;
  readonly renderer: RuntimeRenderer;
  readonly root: InteractiveComponent;
  readonly alternateScreen?: boolean;
  readonly onError?: (error: unknown) => void;
}

/** Owns terminal lifecycle, key dispatch, resize handling, and render batching. */
export class TuiRuntime {
  private readonly terminal: RuntimeTerminal;
  private readonly renderer: RuntimeRenderer;
  private root: InteractiveComponent;
  private readonly alternateScreen: boolean;
  private readonly onError: (error: unknown) => void;
  private disposeKey: (() => void) | undefined;
  private disposeResize: (() => void) | undefined;
  private scheduled = false;
  private running = false;

  constructor(options: TuiRuntimeOptions) {
    this.terminal = options.terminal;
    this.renderer = options.renderer;
    this.root = options.root;
    this.alternateScreen = options.alternateScreen ?? true;
    this.onError = options.onError ?? ((error) => {
      queueMicrotask(() => { throw error; });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    let terminalStarted = false;
    try {
      this.terminal.start();
      terminalStarted = true;
      if (this.alternateScreen) this.terminal.enterAlternateScreen?.();
      this.disposeKey = this.terminal.onKey(this.handleKey);
      this.disposeResize = this.terminal.onResize(this.handleResize);
      this.running = true;
      this.renderNow();
    } catch (error) {
      this.running = false;
      this.disposeKey?.();
      this.disposeResize?.();
      this.disposeKey = undefined;
      this.disposeResize = undefined;
      if (terminalStarted) this.renderer.dispose();
      this.terminal.close();
      throw error;
    }
  }

  setRoot(root: InteractiveComponent): void {
    this.root = root;
    this.renderer.invalidate();
    this.requestRender();
  }

  requestRender(): void {
    if (!this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.running) this.safeRender();
    });
  }

  renderNow(): void {
    if (!this.running) return;
    this.renderer.render(this.root.render(this.terminal.size), this.terminal.size);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.scheduled = false;
    this.disposeKey?.();
    this.disposeResize?.();
    this.disposeKey = undefined;
    this.disposeResize = undefined;
    try { this.renderer.dispose(); } finally { this.terminal.close(); }
  }

  private readonly handleKey = (stroke: KeyStroke): void => {
    try {
      if (this.root.handleKey(stroke)) this.requestRender();
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly handleResize = (): void => {
    this.renderer.invalidate();
    this.requestRender();
  };

  private safeRender(): void {
    try {
      this.renderNow();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stop();
    this.onError(error);
  }
}
