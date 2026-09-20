import AnsiParser from "node-ansiparser";
import { createSupportsTerminalGraphics } from "supports-terminal-graphics";

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | "none";

export function terminalImageProtocol(output: { readonly isTTY?: boolean } = process.stdout): ImageProtocol {
  const setting = process.env.MAY_IMAGE_PROTOCOL;
  if (setting !== undefined && !["auto", "kitty", "iterm2", "sixel", "none"].includes(setting)) throw new Error("MAY_IMAGE_PROTOCOL must be auto, kitty, iterm2, sixel or none");
  if (setting && setting !== "auto") return setting as ImageProtocol;
  if (!output.isTTY || process.env.TMUX || process.env.STY) return "none";
  const graphics = createSupportsTerminalGraphics(output);
  return graphics.iterm2 ? "iterm2" : graphics.kitty ? "kitty" : graphics.sixel || process.env.WT_SESSION ? "sixel" : "none";
}

export interface TerminalCellSize {
  readonly width: number;
  readonly height: number;
}

/** 接收 tty-events 分离的终端响应，保持键盘输入独立。 */
export class TerminalImageSupport {
  readonly protocol: ImageProtocol;
  private measured: TerminalCellSize | undefined;
  private supported: boolean;
  private consumed = false;
  private readonly listeners = new Set<() => void>();
  private readonly parser = new AnsiParser({
    inst_c: (collected, params, flag) => {
      if (collected === "?" && flag === "c") {
        this.consumed = true;
        this.supported = this.forced || params.slice(1).includes(4);
        this.changed();
      } else if (collected === "" && flag === "t" && params[0] === 6 && params.length === 3) {
        this.consumed = true;
        const [, height, width] = params;
        if (!width || !height || width > 256 || height > 512) throw new RangeError("Invalid terminal cell pixel size");
        this.measured = { width, height };
        this.changed();
      }
    },
  });

  constructor(
    private readonly output: { write(value: string): unknown; readonly isTTY?: boolean },
    private readonly forced = process.env.MAY_IMAGE_PROTOCOL === "sixel",
  ) {
    this.protocol = terminalImageProtocol(output);
    this.supported = forced;
  }

  get cellSize(): TerminalCellSize | undefined { return this.supported ? this.measured : undefined; }

  query(): void {
    if (this.protocol !== "sixel" || !this.output.isTTY) return;
    this.measured = undefined;
    this.changed();
    this.output.write("\x1b[c\x1b[16t");
  }

  consume(sequence: string): boolean {
    if (this.protocol !== "sixel") return false;
    this.consumed = false;
    this.parser.reset();
    this.parser.parse(sequence);
    return this.consumed;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ready(): Promise<void> {
    if (this.protocol !== "sixel" || this.cellSize) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); dispose(); resolve(); };
      const dispose = this.onChange(() => { if (this.cellSize) finish(); });
      const timer = setTimeout(finish, 300);
    });
  }

  private changed(): void { for (const listener of this.listeners) listener(); }
}
