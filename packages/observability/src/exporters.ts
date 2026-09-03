import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  readonly path: string;
}

/** Appends one completed span per line without holding an open file handle. */
export class JsonlFileSpanExporter implements SpanExporter {
  readonly path: string;

  private tail: Promise<void> = Promise.resolve();
  private directoryReady: Promise<void> | undefined;

  constructor(options: JsonlFileSpanExporterOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("JsonlFileSpanExporter options must be an object");
    }
    if (typeof options.path !== "string" || options.path.trim() === "") {
      throw new TypeError("JsonlFileSpanExporter path must be a non-empty string");
    }
    this.path = resolve(options.path);
  }

  export(spans: readonly FinishedTraceSpan[]): Promise<void> {
    if (spans.length === 0) return this.tail;
    const payload = `${spans.map((span) => JSON.stringify(span)).join("\n")}\n`;
    const operation = this.tail.then(async () => {
      this.directoryReady ??= mkdir(dirname(this.path), { recursive: true })
        .then(() => undefined);
      await this.directoryReady;
      await appendFile(this.path, payload, "utf8");
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async shutdown(): Promise<void> {
    await this.tail;
  }
}
