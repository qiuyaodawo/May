export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Trigger =
  | { readonly type: "at"; readonly time: string }
  | { readonly type: "cron"; readonly expression: string; readonly timezone: string }
  | { readonly type: "event"; readonly topic: string };

export interface ScheduledTask {
  readonly handler: string;
  readonly payload: JsonValue;
}

export interface MisfirePolicy {
  readonly policy: "skip" | "latest";
  readonly graceMs: number;
}

export interface CreateJobInput {
  readonly id: string;
  readonly enabled: boolean;
  readonly trigger: Trigger;
  readonly task: ScheduledTask;
  readonly misfire: MisfirePolicy;
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, "id">>;

export interface ScheduledJob extends CreateJobInput {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAt?: string;
}

export interface SchedulerEvent {
  readonly source: string;
  readonly id: string;
  readonly topic: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

export type ExecutionStatus = "pending" | "dispatching" | "submitted" | "failed" | "skipped";

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

export interface TaskSubmission {
  readonly executionId: string;
  readonly handler: string;
  readonly payload: JsonValue;
  readonly scheduledAt?: string;
  readonly event?: SchedulerEvent;
}

export interface TaskDispatcher {
  submit(request: TaskSubmission): Promise<{ taskId: string }>;
}

/** 宿主仅在能够确认没有接受任务时使用此错误。 */
export class TaskRejectedError extends Error {
  readonly code = "TASK_REJECTED";
  constructor(message: string) {
    super(message);
    this.name = "TaskRejectedError";
  }
}

/** transaction 必须同步执行并原子提交，打开存储时取得独占使用权。 */
export interface SchedulerStore {
  get<T>(collection: string, id: string): T | undefined;
  list<T>(collection: string): T[];
  put(collection: string, id: string, value: unknown): void;
  delete(collection: string, id: string): void;
  transaction<T>(operation: () => T): T;
  close(): void;
}

export interface SchedulerOptions {
  readonly store: SchedulerStore;
  readonly dispatcher: TaskDispatcher;
  readonly maxConcurrentSubmissions?: number;
  /** start() 必须提供错误处理器，后台错误会停止计时器。 */
  readonly onError?: (error: unknown) => void;
}

export interface ExecutionQuery {
  readonly jobId?: string;
  readonly status?: ExecutionStatus;
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface ExecutionPage {
  readonly records: readonly ExecutionRecord[];
  readonly nextAfterSeq?: number;
}

export interface TickResult {
  readonly created: number;
  readonly submitted: number;
  readonly failed: number;
  readonly skipped: number;
}
