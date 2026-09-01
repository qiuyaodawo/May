export type TerminalColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite"
  | `#${string}`
  | number
  | "";

export interface TextStyle {
  readonly foreground?: TerminalColor;
  readonly background?: TerminalColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strikethrough?: boolean;
}

export interface MarkdownTheme {
  readonly heading: TextStyle;
  readonly link: TextStyle;
  readonly linkUrl: TextStyle;
  readonly code: TextStyle;
  readonly codeBlock: TextStyle;
  readonly codeBlockBorder: TextStyle;
  readonly quote: TextStyle;
  readonly quoteBorder: TextStyle;
  readonly horizontalRule: TextStyle;
  readonly listBullet: TextStyle;
}

/** Semantic tokens shared by May-owned terminal applications. */
export interface TuiTheme {
  readonly name: string;
  readonly text: TextStyle;
  readonly accent: TextStyle;
  readonly muted: TextStyle;
  readonly dim: TextStyle;
  readonly success: TextStyle;
  readonly warning: TextStyle;
  readonly error: TextStyle;
  readonly border: TextStyle;
  readonly borderAccent: TextStyle;
  readonly selected: TextStyle;
  readonly userMessage: TextStyle;
  readonly assistantLabel: TextStyle;
  readonly thinking: TextStyle;
  readonly toolTitle: TextStyle;
  readonly toolOutput: TextStyle;
  readonly toolPending: TextStyle;
  readonly toolSuccess: TextStyle;
  readonly toolError: TextStyle;
  readonly diffAdded: TextStyle;
  readonly diffRemoved: TextStyle;
  readonly diffContext: TextStyle;
  readonly markdown: MarkdownTheme;
}

export const DEFAULT_DARK_THEME: TuiTheme = {
  name: "may-dark",
  text: {},
  accent: { foreground: "brightCyan", bold: true },
  muted: { foreground: "brightBlack" },
  dim: { foreground: "brightBlack", dim: true },
  success: { foreground: "brightGreen" },
  warning: { foreground: "brightYellow" },
  error: { foreground: "brightRed" },
  border: { foreground: "brightBlack" },
  borderAccent: { foreground: "brightCyan" },
  selected: { foreground: "brightWhite", background: 237, bold: true },
  userMessage: { foreground: "brightWhite", bold: true },
  assistantLabel: { foreground: "brightCyan", bold: true },
  thinking: { foreground: "brightBlack", italic: true },
  toolTitle: { foreground: "brightBlue", bold: true },
  toolOutput: { foreground: "white" },
  toolPending: { foreground: "brightYellow" },
  toolSuccess: { foreground: "brightGreen" },
  toolError: { foreground: "brightRed" },
  diffAdded: { foreground: "brightGreen" },
  diffRemoved: { foreground: "brightRed" },
  diffContext: { foreground: "brightBlack" },
  markdown: {
    heading: { foreground: "brightCyan", bold: true },
    link: { foreground: "brightBlue", underline: true },
    linkUrl: { foreground: "brightBlack" },
    code: { foreground: "brightYellow" },
    codeBlock: { foreground: "white" },
    codeBlockBorder: { foreground: "brightBlack" },
    quote: { foreground: "white", italic: true },
    quoteBorder: { foreground: "brightBlack" },
    horizontalRule: { foreground: "brightBlack" },
    listBullet: { foreground: "brightCyan" },
  },
};

/** Apply framework-generated SGR styles without accepting raw escape codes. */
export function styleText(value: string, style: TextStyle | undefined): string {
  if (value === "" || style === undefined) return value;
  const open: number[] = [];
  const close: number[] = [];
  appendColor(open, close, style.foreground, false);
  appendColor(open, close, style.background, true);
  appendEffect(open, close, style.bold, 1, 22);
  appendEffect(open, close, style.dim, 2, 22);
  appendEffect(open, close, style.italic, 3, 23);
  appendEffect(open, close, style.underline, 4, 24);
  appendEffect(open, close, style.inverse, 7, 27);
  appendEffect(open, close, style.strikethrough, 9, 29);
  if (open.length === 0) return value;
  return `\x1b[${open.join(";")}m${value}\x1b[${[...new Set(close.reverse())].join(";")}m`;
}

export function mergeTextStyles(
  base: TextStyle,
  overrides: TextStyle,
): TextStyle {
  return { ...base, ...overrides };
}

function appendEffect(
  open: number[],
  close: number[],
  enabled: boolean | undefined,
  openCode: number,
  closeCode: number,
): void {
  if (!enabled) return;
  open.push(openCode);
  close.push(closeCode);
}

function appendColor(
  open: number[],
  close: number[],
  color: TerminalColor | undefined,
  background: boolean,
): void {
  if (color === undefined || color === "") return;
  const prefix = background ? 48 : 38;
  const reset = background ? 49 : 39;
  if (typeof color === "number") {
    open.push(prefix, 5, clampByte(color));
    close.push(reset);
    return;
  }
  if (color.startsWith("#")) {
    const rgb = parseHexColor(color);
    if (rgb === undefined) throw new Error(`Invalid terminal color: ${color}`);
    open.push(prefix, 2, rgb.red, rgb.green, rgb.blue);
    close.push(reset);
    return;
  }
  const code = NAMED_COLORS[color as keyof typeof NAMED_COLORS];
  open.push(code + (background ? 10 : 0));
  close.push(reset);
}

function parseHexColor(value: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} | undefined {
  const short = /^#([\da-f])([\da-f])([\da-f])$/iu.exec(value);
  if (short !== null) {
    return {
      red: Number.parseInt(short[1]! + short[1]!, 16),
      green: Number.parseInt(short[2]! + short[2]!, 16),
      blue: Number.parseInt(short[3]! + short[3]!, 16),
    };
  }
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(value);
  return full === null
    ? undefined
    : {
        red: Number.parseInt(full[1]!, 16),
        green: Number.parseInt(full[2]!, 16),
        blue: Number.parseInt(full[3]!, 16),
      };
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("ANSI color index must be finite");
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

const NAMED_COLORS: Readonly<Record<Exclude<TerminalColor, number | `#${string}` | "">, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};
