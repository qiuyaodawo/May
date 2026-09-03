import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { FinishedTraceSpan, SpanExporter } from "./types.js";

export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: FinishedTraceSpan[] = [];

  export(spans: readonly FinishedTraceSpan[]): void {
    this.spans.push(...spans);
  }

  getFinishedSpans(): readonly FinishedTraceSpan[] {
    return [...this.spans];
  }

  clear(): void {
    this.spans.length = 0;
  }
}

export interface ConsoleSpanExporterOptions {
  readonly write?: (line: string) => void;
}

/** Writes one content-free completed span as JSON per line. */
export class ConsoleSpanExporter implements SpanExporter {
  private readonly write: (line: string) => void;

  constructor(options: ConsoleSpanExporterOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
  }

  export(spans: readonly FinishedTraceSpan[]): void {
    for (const span of spans) this.write(JSON.stringify(span));
  }
}

export interface JsonlFileSpanExporterOptions {
  /** Base file path. Daily rotation inserts YYYY-MM-DD before its extension. */
  readonly path: string;
  readonly rotation?: "daily";
  /** Number of local calendar days retained, including today. Defaults to 60. */
  readonly retentionDays?: number;
  readonly clock?: () => number;
}

/** Appends one completed span per line without holding an open file handle. */
export class JsonlFileSpanExporter implements SpanExporter {
  readonly path: string;

  private readonly rotation: "daily" | undefined;
  private readonly retentionDays: number;
  private readonly clock: () => number;
  private tail: Promise<void> = Promise.resolve();
  private directoryReady: Promise<void> | undefined;
  private lastCleanupDate: string | undefined;

  constructor(options: JsonlFileSpanExporterOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("JsonlFileSpanExporter options must be an object");
    }
    if (typeof options.path !== "string" || options.path.trim() === "") {
      throw new TypeError("JsonlFileSpanExporter path must be a non-empty string");
    }
    if (options.rotation !== undefined && options.rotation !== "daily") {
      throw new TypeError('JsonlFileSpanExporter rotation must be "daily"');
    }
    if (
      options.retentionDays !== undefined &&
      (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1)
    ) {
      throw new RangeError("retentionDays must be a positive safe integer");
    }
    if (options.retentionDays !== undefined && options.rotation === undefined) {
      throw new TypeError("retentionDays requires daily rotation");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("JsonlFileSpanExporter clock must be a function");
    }
    this.path = resolve(options.path);
    this.rotation = options.rotation;
    this.retentionDays = options.retentionDays ?? 60;
    this.clock = options.clock ?? Date.now;
  }

  export(spans: readonly FinishedTraceSpan[]): Promise<void> {
    if (spans.length === 0) return this.tail;
    const operation = this.tail.then(async () => {
      await this.prepareDirectory();
      if (this.rotation === undefined) {
        await appendSpans(this.path, spans);
        return;
      }

      const today = localDate(this.clock());
      const cutoff = retentionCutoff(today, this.retentionDays);
      await this.cleanup(today, cutoff);
      const groups = new Map<string, FinishedTraceSpan[]>();
      for (const span of spans) {
        const date = localDate(span.endTime);
        if (date < cutoff) continue;
        const group = groups.get(date);
        if (group === undefined) groups.set(date, [span]);
        else group.push(span);
      }
      for (const [date, group] of groups) {
        await appendSpans(this.rotatedPath(date), group);
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async shutdown(): Promise<void> {
    await this.tail;
  }

  private async prepareDirectory(): Promise<void> {
    this.directoryReady ??= mkdir(dirname(this.path), { recursive: true })
      .then(() => undefined);
    await this.directoryReady;
  }

  private rotatedPath(date: string): string {
    const extension = extname(this.path);
    const name = basename(this.path);
    const stem = extension === "" ? name : name.slice(0, -extension.length);
    return join(dirname(this.path), `${stem}-${date}${extension}`);
  }

  private async cleanup(today: string, cutoff: string): Promise<void> {
    if (this.lastCleanupDate === today) return;
    const extension = extname(this.path);
    const name = basename(this.path);
    const stem = extension === "" ? name : name.slice(0, -extension.length);
    const pattern = new RegExp(
      `^${escapeRegExp(stem)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegExp(extension)}$`,
      "u",
    );
    const entries = await readdir(dirname(this.path), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = pattern.exec(entry.name);
      if (match?.[1] === undefined || match[1] >= cutoff) continue;
      try {
        await unlink(join(dirname(this.path), entry.name));
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    this.lastCleanupDate = today;
  }
}

async function appendSpans(
  path: string,
  spans: readonly FinishedTraceSpan[],
): Promise<void> {
  const payload = `${spans.map((span) => JSON.stringify(span)).join("\n")}\n`;
  await appendFile(path, payload, "utf8");
}

function localDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("span timestamp must be a finite number");
  }
  const date = new Date(timestamp);
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function retentionCutoff(today: string, retentionDays: number): string {
  const [year, month, day] = today.split("-").map(Number);
  const cutoff = new Date(year!, month! - 1, day!);
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
  return localDate(cutoff.getTime());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
