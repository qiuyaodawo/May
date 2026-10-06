import type { UiPanel } from "./protocol.js";

export interface UiTelemetryRecord {
  readonly name: string;
  readonly startTime: number;
  readonly durationMs?: number;
  readonly ended: boolean;
  readonly status?: string;
  readonly sampled: boolean;
  readonly context: { readonly spanId: string; readonly traceId: string };
  readonly parentSpanId?: string;
}

export interface UiTelemetryData {
  readonly spans: readonly UiTelemetryRecord[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly evictedSpans: number;
}

/** 显示每项独立耗时，保留父子身份，供不同宿主复用。 */
export function createTelemetryPanel(data: UiTelemetryData | undefined): UiPanel {
  if (data === undefined) return { id: "telemetry", title: "运行诊断", fields: [{ label: "状态", value: "当前宿主没有启用遥测。" }] };
  const spans = [...data.spans].sort((a, b) => a.startTime - b.startTime);
  return {
    id: "telemetry", title: "运行诊断",
    fields: [
      { label: "记录范围", value: `${data.total} 条本地记录，${data.evictedSpans} 条已超过保留范围${data.hasMore ? "，还有后续记录" : ""}。` },
      ...spans.slice(0, 40).map(span => ({
        label: `${new Date(span.startTime).toISOString()} · ${span.name}`,
        value: `${span.ended ? span.status ?? "未知结果" : "正在执行"} · ${span.durationMs === undefined ? "耗时尚未确定" : `${span.durationMs} ms`} · span ${span.context.spanId}${span.parentSpanId === undefined ? "" : ` · parent ${span.parentSpanId}`} · ${span.sampled ? "已选择远程导出" : "本地记录"}`,
      })),
    ],
  };
}
