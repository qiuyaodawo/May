import type { KeyStroke } from "@may/keybindings";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import type {
  Component,
  InteractiveComponent,
  RenderResult,
  RenderSize,
} from "./component.js";
import { styleText, type TextStyle } from "./theme.js";

export interface OverlayOptions {
  readonly width?: number;
  readonly height?: number;
  readonly horizontal?: "left" | "center" | "right";
  readonly vertical?: "top" | "center" | "bottom";
}

export class Overlay implements Component {
  constructor(
    private readonly base: Component,
    private readonly foreground: Component,
    private readonly options: OverlayOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    const base = this.base.render(size);
    const width = clamp(this.options.width ?? Math.min(60, size.width), 1, size.width);
    const height = clamp(this.options.height ?? Math.min(12, size.height), 1, size.height);
    const left = alignmentOffset(size.width, width, this.options.horizontal ?? "center");
    const top = alignmentOffset(size.height, height, this.options.vertical ?? "center");
    const foreground = this.foreground.render({ width, height });
    const lines = Array.from({ length: size.height }, (_, row) =>
      fitLine(base.lines[row] ?? "", size.width)
    );

    for (let row = 0; row < height; row++) {
      lines[top + row] = replaceColumns(
        lines[top + row]!,
        left,
        width,
        foreground.lines[row] ?? "",
        size.width,
      );
    }
    return {
      lines,
      ...(foreground.cursor === undefined
        ? {}
        : {
            cursor: {
              ...foreground.cursor,
              x: foreground.cursor.x + left,
              y: foreground.cursor.y + top,
            },
          }),
    };
  }
}

export interface PanelOptions {
  readonly title?: string;
  readonly borderStyle?: TextStyle;
  readonly titleStyle?: TextStyle;
}

export class Panel implements Component {
  constructor(
    private readonly child: Component,
    private readonly options: PanelOptions = {},
  ) {}

  render(size: RenderSize): RenderResult {
    if (size.width < 2 || size.height < 2) {
      return { lines: Array.from({ length: size.height }, () => "·") };
    }
    const innerWidth = size.width - 2;
    const innerHeight = size.height - 2;
    const child = innerWidth > 0 && innerHeight > 0
      ? this.child.render({ width: innerWidth, height: innerHeight })
      : { lines: [] };
    const title = this.options.title === undefined
      ? ""
      : ` ${singleLine(this.options.title)} `;
    const top = styleText(`┌${fitLine(title, innerWidth, "─")}┐`, this.options.borderStyle);
    const bottom = styleText(`└${"─".repeat(innerWidth)}┘`, this.options.borderStyle);
    const side = styleText("│", this.options.borderStyle);
    const body = Array.from({ length: innerHeight }, (_, row) =>
      `${side}${fitLine(child.lines[row] ?? "", innerWidth)}${side}`
    );
    const styledTop = title === "" || this.options.titleStyle === undefined
      ? top
      : replaceTitleStyle(top, title, this.options.titleStyle);
    return {
      lines: [styledTop, ...body, bottom],
      ...(child.cursor === undefined
        ? {}
        : { cursor: { ...child.cursor, x: child.cursor.x + 1, y: child.cursor.y + 1 } }),
    };
  }
}

export interface DialogOptions extends OverlayOptions, PanelOptions {
  readonly open?: boolean;
  readonly dismissOnEscape?: boolean;
  readonly onClose?: () => void;
}

/** Modal input routing plus a bordered overlay. */
export class Dialog implements InteractiveComponent {
  private opened: boolean;

  constructor(
    private readonly base: InteractiveComponent,
    private readonly content: InteractiveComponent,
    private readonly options: DialogOptions = {},
  ) {
    this.opened = options.open ?? false;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): boolean {
    if (this.opened) return false;
    this.opened = true;
    return true;
  }

  close(): boolean {
    if (!this.opened) return false;
    this.opened = false;
    this.options.onClose?.();
    return true;
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.opened) return this.base.handleKey(stroke);
    if (stroke.key === "escape" && (this.options.dismissOnEscape ?? true)) {
      return this.close();
    }
    return this.content.handleKey(stroke);
  }

  render(size: RenderSize): RenderResult {
    if (!this.opened) return this.base.render(size);
    return new Overlay(
      this.base,
      new Panel(
        this.content,
        this.options,
      ),
      this.options,
    ).render(size);
  }
}

function replaceColumns(
  base: string,
  start: number,
  width: number,
  replacement: string,
  totalWidth: number,
): string {
  const before = fitLine(sliceAnsi(base, 0, start), start);
  const middle = fitLine(replacement, width);
  const after = sliceAnsi(base, start + width, totalWidth);
  return fitLine(`${before}${middle}${after}`, totalWidth);
}

function fitLine(value: string, width: number, fill = " "): string {
  const clipped = sliceAnsi(value.replace(/[\r\n]/gu, ""), 0, width);
  return `${clipped}${fill.repeat(Math.max(0, width - stringWidth(clipped)))}`;
}

function alignmentOffset(
  available: number,
  used: number,
  alignment: "left" | "center" | "right" | "top" | "bottom",
): number {
  if (alignment === "left" || alignment === "top") return 0;
  if (alignment === "right" || alignment === "bottom") return available - used;
  return Math.floor((available - used) / 2);
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function replaceTitleStyle(
  line: string,
  title: string,
  titleStyle: TextStyle,
): string {
  const start = 1;
  const before = sliceAnsi(line, 0, start);
  const after = sliceAnsi(line, start + stringWidth(title));
  return `${before}${styleText(title, titleStyle)}${after}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
