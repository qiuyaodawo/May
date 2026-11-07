import type { TelemetryCorrelation, Tracer } from "@sortedyuan/may/core";

/** @experimental */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** @experimental */
export type Trigger =
  | { readonly type: "at"; readonly time: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone: string }
  | { readonly type: "event"; readonly topic: string };

/** @experimental */
export interface ScheduledTask {
  readonly handler: string;
  readonly payload: JsonValue;
}

/** @experimental */
export interface MisfirePolicy {
  readonly policy: "skip" | "latest";
  readonly graceMs: number;
}

/** @experimental */
export interface CreateJobInput {
  readonly id: string;
  readonly enabled: boolean;
  readonly trigger: Trigger;
  readonly task: ScheduledTask;
  readonly misfire: MisfirePolicy;
}

/** @experimental */
export type UpdateJobInput = Partial<Omit<CreateJobInput, "id">>;

/** @experimental */
export interface ScheduledJob extends CreateJobInput {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAt?: string;
}

/** @experimental */
export interface SchedulerEvent {
  readonly source: string;
  readonly id: string;
  readonly topic: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

/** @experimental */
export type ExecutionStatus = "pending" | "dispatching" | "submitted" | "failed" | "skipped";

/** @experimental */
export interface ExecutionRecord {
  readonly id: string;
  readonly seq: number;
  readonly job: ScheduledJob;
  readonly status: ExecutionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scheduledAt?: string;
  readonly event?: SchedulerEvent;
  readonly taskId?: string;
  readonly detail?: string;
}

/** @experimental */
export interface TaskSubmission {
  readonly telemetry?: TelemetryCorrelation;
  readonly executionId: string;
  readonly handler: string;
  readonly payload: JsonValue;
  readonly scheduledAt?: string;
  readonly event?: SchedulerEvent;
}

/** @experimental */
export interface TaskDispatcher {
  submit(request: TaskSubmission): Promise<{ taskId: string }>;
}

/**
 * 宿主仅在能够确认没有接受任务时使用此错误。
 * @experimental
 */
export class TaskRejectedError extends Error {
  readonly code = "TASK_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "TaskRejectedError";
  }
}

/**
 * transaction 必须同步执行并原子提交，打开存储时取得独占使用权。
 * @experimental
 */
export interface SchedulerStore {
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): T[];
  put(collection: string, id: string, value: unknown): void;
  delete(collection: string, id: string): void;
  transaction<T>(operation: () => T): T;
  close(): void;
}

/** @experimental */
export interface SchedulerOptions {
  readonly tracer?: Tracer;
  readonly telemetry?: TelemetryCorrelation;
  readonly store: SchedulerStore;
  readonly dispatcher: TaskDispatcher;
  readonly maxConcurrentSubmissions?: number;
  /** start() 必须提供错误处理器，后台错误会停止计时器。 */
  readonly onError?: (error: unknown) => void;
}

/** @experimental */
export interface ExecutionQuery {
  readonly jobId?: string;
  readonly status?: ExecutionStatus;
  readonly afterSeq?: number;
  readonly limit?: number;
}

/** @experimental */
export interface ExecutionPage {
  readonly records: readonly ExecutionRecord[];
  readonly nextAfterSeq?: number;
}

/** @experimental */
export interface TickResult {
  readonly created: number;
  readonly submitted: number;
  readonly failed: number;
  readonly skipped: number;
}
