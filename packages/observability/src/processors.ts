import type {
  FinishedTraceSpan,
  ObservabilityErrorHandler,
  SpanExporter,
  SpanProcessor,
} from "./types.js";

/** Deterministic processor intended for tests and local inspection. */
export class InMemorySpanProcessor implements SpanProcessor {
  private readonly finished: FinishedTraceSpan[] = [];
  private dropped = 0;
  constructor(private readonly maxSpans = 2_048) { positiveInteger(maxSpans, "maxSpans"); }
  get droppedSpans(): number { return this.dropped; }

  onEnd(span: FinishedTraceSpan): void {
    this.finished.push(span);
    if (this.finished.length > this.maxSpans) { this.finished.shift(); this.dropped += 1; }
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
  private readonly processor: BatchSpanProcessor;

  constructor(
    exporter: SpanExporter,
    onError?: ObservabilityErrorHandler,
    options: Omit<BatchSpanProcessorOptions, "maxExportBatchSize" | "onError"> = {},
  ) {
    this.processor = new BatchSpanProcessor(exporter, { ...options, maxExportBatchSize: 1, ...(onError === undefined ? {} : { onError }) });
  }

  get droppedSpans(): number { return this.processor.droppedSpans; }
  getDiagnostics(): ProcessorDiagnostics { return this.processor.getDiagnostics(); }

  onEnd(span: FinishedTraceSpan): void {
    this.processor.onEnd(span);
  }

  async forceFlush(): Promise<void> {
    await this.processor.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.processor.shutdown();
  }
}

export interface BatchSpanProcessorOptions {
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMs?: number;
  readonly onError?: ObservabilityErrorHandler;
  readonly exportTimeoutMs?: number;
  readonly metrics?: import("./types.js").MetricRecorder;
}

export interface ProcessorDiagnostics {
  readonly queueSize: number;
  readonly exporting: boolean;
  readonly droppedSpans: number;
  readonly exportFailures: number;
  readonly exportTimeouts: number;
  readonly closed: boolean;
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
  private shutdownStarted = false;
  private dropped = 0;
  private failures = 0;
  private timeouts = 0;
  private readonly exportTimeoutMs: number;
  private readonly metrics: import("./types.js").MetricRecorder | undefined;

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
    if (this.scheduledDelayMs > 2_147_483_647) throw new RangeError("scheduledDelayMs exceeds timer range");
    this.onError = options.onError;
    this.exportTimeoutMs = positiveInteger(options.exportTimeoutMs ?? 5_000, "exportTimeoutMs");
    if (this.exportTimeoutMs > 2_147_483_647) throw new RangeError("exportTimeoutMs exceeds timer range");
    this.metrics = options.metrics;
  }

  get droppedSpans(): number {
    return this.dropped;
  }

  getDiagnostics(): ProcessorDiagnostics {
    return { queueSize: this.queue.length, exporting: this.exporting !== undefined, droppedSpans: this.dropped, exportFailures: this.failures, exportTimeouts: this.timeouts, closed: this.closed };
  }

  onEnd(span: FinishedTraceSpan): void {
    if (this.closed) { this.drop(1); return; }
    if (this.queue.length >= this.maxQueueSize) {
      this.drop(1);
      return;
    }
    this.queue.push(span);
    this.queueMetric();
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
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.closed = true;
    await this.forceFlush();
    try { await boundedOperation(Promise.resolve().then(() => this.exporter.shutdown?.()), this.exportTimeoutMs); }
    catch (error) {
      this.failures += 1;
      if (error instanceof ExportTimeoutError) this.timeouts += 1;
      this.metric({ name: "may.telemetry.export_failures", kind: "counter", value: 1 });
      reportError(this.onError, error);
    }
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
    this.queueMetric();
    if (batch.length === 0) return;
    this.exporting = Promise.resolve().then(async () => {
      try {
        await boundedOperation(Promise.resolve().then(() => this.exporter.export(batch)), this.exportTimeoutMs);
      } catch (error) {
        this.failures += 1;
        this.metric({ name: "may.telemetry.export_failures", kind: "counter", value: 1 });
        if (error instanceof ExportTimeoutError) {
          this.timeouts += 1;
          this.closed = true;
          this.drop(this.queue.length);
          this.queue.length = 0;
          this.cancelTimer();
          this.queueMetric();
        }
        reportError(this.onError, error);
      } finally {
        this.exporting = undefined;
        if (this.queue.length >= this.maxExportBatchSize) {
          this.startExport();
        } else if (this.queue.length > 0 && !this.closed) {
          this.schedule();
        }
      }
    });
  }

  private drop(count: number): void {
    this.dropped += count;
    this.metric({ name: "may.telemetry.dropped_spans", kind: "counter", value: count });
  }
  private queueMetric(): void { this.metric({ name: "may.telemetry.queue_size", kind: "gauge", value: this.queue.length }); }
  private metric(record: import("@may/core").MetricRecord): void {
    try { this.metrics?.record(record); } catch (error) { reportError(this.onError, error); }
  }
}

class ExportTimeoutError extends Error { constructor() { super("Telemetry export timed out"); this.name = "ExportTimeoutError"; } }

async function boundedOperation<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ExportTimeoutError()), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
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

function reportError(
  handler: ObservabilityErrorHandler | undefined,
  error: unknown,
): void {
  try {
    handler?.(error);
  } catch {
    // 导出错误与 Agent 执行保持独立。
  }
}
