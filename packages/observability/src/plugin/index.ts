import { resolve } from "node:path";
import { services } from "@sortedyuan/may/services";
import { definePlugin, defineService } from "@sortedyuan/may/plugin";
import {
  BasicTracer,
  BatchSpanProcessor,
  JsonlFileSpanExporter,
  ratioSampler,
  BoundedMetrics,
  DiagnosticsStore,
} from "../index.js";
import { omitUndefined, type TraceAttributes } from "@sortedyuan/may/core";

export interface ObservabilityPluginOptions {
  readonly dataDirectory: string;
  readonly file?: string;
  readonly samplingRatio?: number;
  readonly retentionDays?: number;
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly scheduledDelayMs?: number;
  readonly resourceAttributes?: TraceAttributes;
  readonly maxDiagnosticSpans?: number;
  readonly diagnosticRetentionMs?: number;
  readonly maxMetricSeries?: number;
}

export interface ObservabilityService {
  readonly processor: BatchSpanProcessor;
  readonly tracer: BasicTracer;
  readonly diagnostics?: DiagnosticsStore;
  readonly metrics?: BoundedMetrics;
}

export const observabilityService = defineService<ObservabilityService>({
  id: "may.observability",
  version: "1.0.0",
  scope: "application",
});
export const observabilityHostService = defineService<ObservabilityService>({
  id: "may.workspace-observability",
  version: "1.0.0",
  scope: "host",
});

function createResources(options: ObservabilityPluginOptions): ObservabilityService {
  const metrics = new BoundedMetrics(omitUndefined({ maxSeries: options.maxMetricSeries }));
  const exporter = new JsonlFileSpanExporter({
    path: resolve(options.dataDirectory, options.file ?? "traces/traces.jsonl"),
    rotation: "daily",
    retentionDays: options.retentionDays ?? 60,
  });
  const processor = new BatchSpanProcessor(
    exporter,
    omitUndefined({
      metrics,
      maxQueueSize: options.maxQueueSize,
      maxExportBatchSize: options.maxExportBatchSize,
      scheduledDelayMs: options.scheduledDelayMs,
    }),
  );
  const diagnostics = new DiagnosticsStore(
    omitUndefined({
      maxSpans: options.maxDiagnosticSpans,
      retentionMs: options.diagnosticRetentionMs,
    }),
  );
  return {
    processor,
    diagnostics,
    metrics,
    tracer: new BasicTracer(
      omitUndefined({
        processor,
        observer: diagnostics,
        metrics,
        sampler: ratioSampler(options.samplingRatio ?? 1),
        resourceAttributes: options.resourceAttributes,
      }),
    ),
  };
}

export function createObservabilityPlugin(options: ObservabilityPluginOptions) {
  return definePlugin({
    id: "may.observability",
    version: "1.0.0",
    scope: "application",
    provides: [observabilityService, services.tracer],
    setup(context) {
      const resources = createResources(options);
      context.defer(() => resources.processor.shutdown());
      context.provide(observabilityService, resources);
      context.provide(services.tracer, resources.tracer);
    },
  });
}

export function createObservabilityHostPlugin(options: ObservabilityPluginOptions) {
  return definePlugin({
    id: "may.workspace-observability",
    version: "1.0.0",
    scope: "host",
    provides: [observabilityHostService],
    setup(context) {
      const resources = createResources(options);
      context.defer(() => resources.processor.shutdown());
      context.provide(observabilityHostService, resources);
    },
  });
}

export function createSharedObservabilityPlugin(resources: ObservabilityService) {
  return definePlugin({
    id: "may.observability",
    version: "1.0.0",
    scope: "application",
    provides: [observabilityService, services.tracer],
    setup(context) {
      context.provide(observabilityService, resources);
      context.provide(services.tracer, resources.tracer);
    },
  });
}
