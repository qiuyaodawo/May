import type { KeyStroke } from "@may/keybindings";
import type {
  InteractiveComponent,
  PointerEvent,
  RenderResult,
  RenderSize,
} from "./component.js";
import type { TerminalWriter } from "./renderer.js";
import type { TerminalImageSupport } from "./image-support.js";

export interface RuntimeTerminal extends TerminalWriter {
  readonly imageSupport?: TerminalImageSupport;
  readonly size: RenderSize;
  start(): void;
  close(): void;
  enterAlternateScreen?(): void;
  onKey(listener: (stroke: KeyStroke) => void): () => void;
  onPointer?(listener: (event: PointerEvent) => void): () => void;
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
  private disposePointer: (() => void) | undefined;
  private scheduled = false;
  private running = false;
  private disposed = false;

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
    this.assertActive();
    if (this.running) return;
    let terminalStarted = false;
    try {
      this.terminal.start();
      terminalStarted = true;
      if (this.alternateScreen) this.terminal.enterAlternateScreen?.();
      this.disposeKey = this.terminal.onKey(this.handleKey);
      this.disposeResize = this.terminal.onResize(this.handleResize);
      this.disposePointer = this.terminal.onPointer?.(this.handlePointer);
      this.running = true;
      this.renderNow();
    } catch (error) {
      this.release(terminalStarted);
      throw error;
    }
  }

  setRoot(root: InteractiveComponent): void {
    this.assertActive();
    if (this.root === root) return;
    this.root.dispose?.();
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
    if (this.disposed) return;
    this.release(this.running);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("TuiRuntime has stopped. Create a new runtime and root component to start again.");
  }

  private release(terminalStarted: boolean): void {
    this.disposed = true;
    this.running = false;
    this.scheduled = false;
    this.disposeKey?.();
    this.disposeResize?.();
    this.disposePointer?.();
    this.disposeKey = undefined;
    this.disposeResize = undefined;
    this.disposePointer = undefined;
    try {
      this.root.dispose?.();
    } finally {
      try {
        if (terminalStarted) this.renderer.dispose();
      } finally { this.terminal.close(); }
    }
  }

  private readonly handleKey = (stroke: KeyStroke): void => {
    try {
      const redraw = this.root.handleKeyResult
        ? this.root.handleKeyResult(stroke).redraw
        : this.root.handleKey(stroke);
      if (redraw) this.requestRender();
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly handlePointer = (event: PointerEvent): void => {
    try {
      if (this.root.handlePointer?.(event)) this.requestRender();
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
