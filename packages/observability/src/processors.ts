import type {
  FinishedTraceSpan,
  ObservabilityErrorHandler,
  SpanExporter,
  SpanProcessor,
} from "./types.js";

/** Deterministic processor intended for tests and local inspection. */
export class InMemorySpanProcessor implements SpanProcessor {
  private readonly finished: FinishedTraceSpan[] = [];

  onEnd(span: FinishedTraceSpan): void {
    this.finished.push(span);
  }

  getFinishedSpans(): readonly FinishedTraceSpan[] {
    return [...this.finished];
  }

  clear(): void {
    this.finished.length = 0;
  }
}

/** Serializes exports off the Agent execution path. */
export class SimpleSpanProcessor implements SpanProcessor {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly exporter: SpanExporter,
    private readonly onError?: ObservabilityErrorHandler,
  ) {}

  onEnd(span: FinishedTraceSpan): void {
    if (this.closed) return;
    this.enqueue([span]);
  }

  async forceFlush(): Promise<void> {
    await this.tail;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.forceFlush();
    await callExporterShutdown(this.exporter, this.onError);
  }

  private enqueue(spans: readonly FinishedTraceSpan[]): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.exporter.export(spans);
      } catch (error) {
        reportError(this.onError, error);
      }
    });
  }
}

export interface BatchSpanProcessorOptions {
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMs?: number;
  readonly onError?: ObservabilityErrorHandler;
}

/** Bounded, non-blocking batch processor for remote or asynchronous exporters. */
export class BatchSpanProcessor implements SpanProcessor {
  private readonly maxQueueSize: number;
  private readonly maxExportBatchSize: number;
  private readonly scheduledDelayMs: number;
  private readonly onError: ObservabilityErrorHandler | undefined;
  private readonly queue: FinishedTraceSpan[] = [];
  private exporting: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private dropped = 0;

  constructor(
    private readonly exporter: SpanExporter,
    options: BatchSpanProcessorOptions = {},
  ) {
    this.maxQueueSize = positiveInteger(
      options.maxQueueSize ?? 2_048,
      "maxQueueSize",
    );
    this.maxExportBatchSize = positiveInteger(
      options.maxExportBatchSize ?? 512,
      "maxExportBatchSize",
    );
    if (this.maxExportBatchSize > this.maxQueueSize) {
      throw new RangeError("maxExportBatchSize cannot exceed maxQueueSize");
    }
    this.scheduledDelayMs = nonNegativeNumber(
      options.scheduledDelayMs ?? 5_000,
      "scheduledDelayMs",
    );
    this.onError = options.onError;
  }

  get droppedSpans(): number {
    return this.dropped;
  }

  onEnd(span: FinishedTraceSpan): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.dropped += 1;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.maxExportBatchSize) {
      this.cancelTimer();
      this.startExport();
    } else {
      this.schedule();
    }
  }

  async forceFlush(): Promise<void> {
    this.cancelTimer();
    while (this.queue.length > 0 || this.exporting !== undefined) {
      if (this.exporting === undefined) this.startExport();
      await this.exporting;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.forceFlush();
    await callExporterShutdown(this.exporter, this.onError);
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startExport();
    }, this.scheduledDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startExport(): void {
    if (this.exporting !== undefined) return;
    const batch = this.queue.splice(0, this.maxExportBatchSize);
    if (batch.length === 0) return;
    this.exporting = (async () => {
      try {
        await this.exporter.export(batch);
      } catch (error) {
        reportError(this.onError, error);
      } finally {
        this.exporting = undefined;
        if (this.queue.length >= this.maxExportBatchSize) {
          this.startExport();
        } else if (this.queue.length > 0 && !this.closed) {
          this.schedule();
        }
      }
    })();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

async function callExporterShutdown(
  exporter: SpanExporter,
  onError: ObservabilityErrorHandler | undefined,
): Promise<void> {
  try {
    await exporter.shutdown?.();
  } catch (error) {
    reportError(onError, error);
  }
}

function reportError(
  handler: ObservabilityErrorHandler | undefined,
  error: unknown,
): void {
  try {
    handler?.(error);
  } catch {
    // Export failures must not become Agent failures.
  }
}
