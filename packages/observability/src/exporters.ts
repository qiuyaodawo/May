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
