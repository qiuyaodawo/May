import { sanitizeTerminalText } from "../text.js";
import { styleText, type TuiTheme } from "../theme.js";
import type { ToolTranscriptItem } from "./transcript-store.js";

export interface ToolTranscriptRenderOptions {
  readonly expanded: boolean;
  readonly selected?: boolean;
  readonly maximumOutputCharacters: number;
  readonly theme: TuiTheme;
  readonly detailsHint?: string;
}

export interface ToolTranscriptRenderer {
  render(
    item: ToolTranscriptItem,
    options: ToolTranscriptRenderOptions,
  ): string;
}

/** Instance-scoped registry: applications can replace presentation without global state. */
export class ToolRendererRegistry {
  private readonly renderers = new Map<string, ToolTranscriptRenderer>();
  private generation = 0;
  get revision(): number { return this.generation; }

  constructor(private readonly fallback: ToolTranscriptRenderer = genericRenderer) {}

  register(name: string, renderer: ToolTranscriptRenderer): this {
    const normalized = name.trim();
    if (normalized === "") throw new Error("Tool renderer name cannot be empty");
    this.renderers.set(normalized, renderer);
    this.generation++;
    return this;
  }

  render(
    item: ToolTranscriptItem,
    options: ToolTranscriptRenderOptions,
  ): string {
    return (this.renderers.get(item.call.name) ?? this.fallback).render(item, options);
  }
}

/** Create renderers for the standard May coding tools. */
export function createCodingToolRendererRegistry(): ToolRendererRegistry {
  return new ToolRendererRegistry()
    .register("shell", shellRenderer)
    .register("bash", shellRenderer)
    .register("read", readRenderer)
    .register("edit", fileChangeRenderer)
    .register("write", fileChangeRenderer);
}

const shellRenderer: ToolTranscriptRenderer = {
  render(item, options) {
    const command = stringField(item.call.input, "command") ?? inputSummary(item.call.input);
    const lines = [header(item, options, command)];
    appendProgress(lines, item, options);

    const output = objectValue(item.output);
    const stdout = stringField(output, "stdout") ?? item.streamedOutput;
    const stderr = stringField(output, "stderr") ?? "";
    if (stdout !== "") appendOutput(lines, stdout, options);
    if (stderr !== "") {
      lines.push(styleText("  stderr", options.theme.error));
      appendOutput(lines, stderr, options, options.theme.error);
    }
    if (item.status === "completed") {
      const exitCode = primitiveField(output, "exitCode");
      const signal = primitiveField(output, "signal");
      const result = exitCode === undefined ? "completed" : `exit ${String(exitCode)}`;
      lines.push(styleText(
        `  └─ ${result}${signal == null ? "" : ` · ${String(signal)}`}`,
        exitCode === 0 || exitCode === undefined
          ? options.theme.muted
          : options.theme.warning,
      ));
    }
    appendFailure(lines, item, options);
    return lines.join("\n");
  },
};

const readRenderer: ToolTranscriptRenderer = {
  render(item, options) {
    const inputPath = stringField(item.call.input, "path") ?? "<unknown>";
    const output = objectValue(item.output);
    const path = stringField(output, "path") ?? inputPath;
    const start = numberField(output, "startLine");
    const end = numberField(output, "endLine");
    const total = numberField(output, "totalLines");
    const range = start === undefined || end === undefined ? "" : `:${start}-${end}`;
    const lines = [header(item, options, `${path}${range}`)];
    appendProgress(lines, item, options);
    if (options.expanded) {
      const content = stringField(output, "content");
      if (content !== undefined && content !== "") {
        const numbered = numberLines(content, start ?? 1);
        appendOutput(lines, numbered, options, options.theme.toolOutput, true);
      }
    } else if (total !== undefined) {
      const count = start === undefined || end === undefined ? 0 : Math.max(0, end - start + 1);
      lines.push(styleText(
        `  └─ ${count} of ${total} lines${options.detailsHint === undefined ? "" : ` · ${options.detailsHint}`}`,
        options.theme.muted,
      ));
    }
    appendFailure(lines, item, options);
    return lines.join("\n");
  },
};

const fileChangeRenderer: ToolTranscriptRenderer = {
  render(item, options) {
    const inputPath = stringField(item.call.input, "path") ?? "<unknown>";
    const preview = item.preview;
    const detail = preview?.status === "ready"
      ? `${preview.path}  +${preview.additions} -${preview.deletions}`
      : inputPath;
    const lines = [header(item, options, detail)];
    appendProgress(lines, item, options);

    if (preview?.status === "ready") {
      if (options.expanded && preview.diff !== "") {
        lines.push(...renderDiff(preview.diff, options.theme));
      } else {
        const hint = options.detailsHint === undefined ? "" : ` · ${options.detailsHint}`;
        lines.push(styleText(`  └─ ${preview.kind}${hint}`, options.theme.muted));
      }
    } else if (preview?.status === "unavailable") {
      lines.push(styleText(
        `  Diff unavailable: ${sanitizeTerminalText(preview.reason)}`,
        options.theme.warning,
      ));
    }
    if (item.status === "completed" && preview === undefined) {
      appendOutput(lines, stringify(item.output), options);
    }
    appendFailure(lines, item, options);
    return lines.join("\n");
  },
};

const genericRenderer: ToolTranscriptRenderer = {
  render(item, options) {
    const lines = [header(item, options, inputSummary(item.call.input))];
    appendProgress(lines, item, options);
    const output = item.streamedOutput !== ""
      ? item.streamedOutput
      : item.status === "completed"
      ? stringify(item.output)
      : "";
    if (output !== "") appendOutput(lines, output, options);
    appendFailure(lines, item, options);
    return lines.join("\n");
  },
};

function header(
  item: ToolTranscriptItem,
  options: ToolTranscriptRenderOptions,
  detail: string,
): string {
  const marker = item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : "●";
  const markerStyle = item.status === "completed"
    ? options.theme.toolSuccess
    : item.status === "failed"
    ? options.theme.toolError
    : options.theme.toolPending;
  const safeDetail = sanitizeTerminalText(detail).replace(/\s+/gu, " ").trim();
  const selection = options.selected === true
    ? styleText("▸", options.theme.accent)
    : " ";
  return `${selection} ${styleText(marker, markerStyle)} ` +
    `${styleText(sanitizeTerminalText(item.call.name), options.theme.toolTitle)}` +
    `${safeDetail === "" ? "" : `  ${safeDetail}`}`;
}

function appendProgress(
  lines: string[],
  item: ToolTranscriptItem,
  options: ToolTranscriptRenderOptions,
): void {
  for (const progress of item.progress.slice(options.expanded ? 0 : -2)) {
    lines.push(styleText(`  ↳ ${sanitizeTerminalText(progress)}`, options.theme.muted));
  }
}

function appendOutput(
  lines: string[],
  value: string,
  options: ToolTranscriptRenderOptions,
  outputStyle = options.theme.toolOutput,
  forceExpanded = false,
): void {
  const safe = sanitizeTerminalText(value).replace(/\s+$/gu, "");
  if (safe === "") return;
  const maximumLines = options.expanded || forceExpanded ? Number.POSITIVE_INFINITY : 4;
  const limitedCharacters = truncateCharacters(safe, options.maximumOutputCharacters);
  const allLines = limitedCharacters.split("\n");
  const displayed = allLines.slice(0, maximumLines);
  for (const line of displayed) {
    lines.push(`${styleText("  │", options.theme.border)} ${styleText(line, outputStyle)}`);
  }
  const omittedLines = allLines.length - displayed.length;
  if (omittedLines > 0) {
    const hint = options.detailsHint === undefined ? "" : ` · ${options.detailsHint}`;
    lines.push(styleText(`  … ${omittedLines} more lines${hint}`, options.theme.muted));
  } else if (limitedCharacters.endsWith("…") && safe !== limitedCharacters) {
    lines.push(styleText("  … output truncated", options.theme.muted));
  }
}

function appendFailure(
  lines: string[],
  item: ToolTranscriptItem,
  options: ToolTranscriptRenderOptions,
): void {
  if (item.status === "failed" && item.error !== undefined) {
    lines.push(styleText(`  ${sanitizeTerminalText(item.error)}`, options.theme.error));
  }
}

function renderDiff(diff: string, theme: TuiTheme): string[] {
  return sanitizeTerminalText(diff).split("\n").map((line) => {
    const style = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
      ? theme.muted
      : line.startsWith("+")
      ? theme.diffAdded
      : line.startsWith("-")
      ? theme.diffRemoved
      : theme.diffContext;
    return `${styleText("  │", theme.border)} ${styleText(line, style)}`;
  });
}

function numberLines(value: string, start: number): string {
  const width = String(start + Math.max(0, value.split("\n").length - 1)).length;
  return value.split("\n").map((line, index) =>
    `${String(start + index).padStart(width)} │ ${line}`
  ).join("\n");
}

function inputSummary(input: unknown): string {
  if (input === undefined) return "";
  const value = stringify(input).replace(/\s+/gu, " ");
  return value === "{}" ? "" : truncateCharacters(value, 160);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown, name: string): string | undefined {
  const object = objectValue(value);
  return typeof object?.[name] === "string" ? object[name] : undefined;
}

function numberField(value: unknown, name: string): number | undefined {
  const object = objectValue(value);
  return typeof object?.[name] === "number" ? object[name] : undefined;
}

function primitiveField(
  value: unknown,
  name: string,
): string | number | boolean | null | undefined {
  const object = objectValue(value);
  const field = object?.[name];
  return field === null || ["string", "number", "boolean"].includes(typeof field)
    ? field as string | number | boolean | null
    : undefined;
}

function truncateCharacters(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1)).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}
