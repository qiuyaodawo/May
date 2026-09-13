import type { AgentApplicationEvent } from "@may/application";
import type { RunBudget, RunBudgetSnapshot, Usage } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";

export type TaskStatus = "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | "recovery-required";

/** Static graph node or host-validated child. Static dependencies must all succeed. */
export interface TaskSpec {
  readonly id: string;
  readonly agent: string;
  readonly input: string;
  readonly dependsOn?: readonly string[];
}

/** Only the explicit answer crosses task boundaries, never reasoning/model state. */
export interface TaskOutput {
  readonly text: string;
  readonly runId?: string;
  readonly usage?: Usage;
  readonly budget?: RunBudgetSnapshot;
}

export interface TaskMessageSpec {
  readonly toTaskId: string;
  readonly text: string;
}

/** Durable task-addressed data. Sender and turn are stamped by the runtime. */
export interface TaskMessage extends TaskMessageSpec {
  readonly id: string;
  readonly fromTaskId: string;
  readonly fromTurn: number;
  readonly deliveredTurn?: number;
}

export interface HandoffSpec {
  readonly agent: string;
  /** Explicit context summary, not a replacement for the original task input. */
  readonly input: string;
}

export interface TaskController {
  readonly agent: string;
  readonly agentVersion: string;
  readonly sessionId: string;
  readonly dispatchId: string;
  readonly sessionStartTurn: number;
  readonly turn: number;
}

export interface TaskHandoff {
  readonly commandId: string;
  readonly input: string;
  readonly from: TaskController;
  readonly to: TaskController;
}

/** The previous terminal attempt stays immutable; retry never rewrites its Session. */
export interface TaskAttempt {
  readonly commandId: string;
  readonly finding: string;
  readonly task: Omit<CoordinationTask, "attempts">;
}

/** Host-only editing of never-submitted top-level graph nodes. */
export interface TaskGraphChange {
  readonly add?: readonly TaskSpec[];
  readonly update?: readonly TaskSpec[];
  readonly remove?: readonly string[];
}

export interface TaskGraphRevision {
  readonly commandId: string;
  readonly change: TaskGraphChange;
  /** Full old nodes preserve replaced/removed dispatch identities. */
  readonly previous: readonly CoordinationTask[];
}

export interface CoordinationTask extends TaskSpec {
  /** Zero-based attempt; absent in older journals means zero. */
  readonly attempt?: number;
  readonly attemptStartTurn?: number;
  readonly attempts?: readonly TaskAttempt[];
  /** Absent in initial fixed-graph journals; equivalent to turn zero. */
  readonly turn?: number;
  /** Global turn at which the current controller's fresh Session began. */
  readonly sessionStartTurn?: number;
  readonly handoffs?: readonly TaskHandoff[];
  /** Intent only. A durable source yield is required before changing controllers. */
  readonly pendingHandoff?: HandoffSpec & { readonly commandId: string; readonly agentVersion: string };
  readonly parentTaskId?: string;
  readonly createdByCommand?: string;
  /** Persisted before yielding; only direct children may be waited on. */
  readonly waitFor?: readonly string[];
  /** An explicit peer-message wait; mutually exclusive with a child wait. */
  readonly waitForMessages?: boolean;
  /** Reserved once before this turn's dispatch, including an empty inbox. */
  readonly inbox?: readonly string[];
  /** Immutable terminal children whose results form this turn's wakeup input. */
  readonly wakeFrom?: readonly string[];
  readonly dependsOn: readonly string[];
  readonly agentVersion: string;
  readonly dispatchId: string;
  readonly sessionId: string;
  readonly status: TaskStatus;
  readonly cancelRequested?: boolean;
  readonly output?: TaskOutput;
  readonly detail?: string;
}

export interface CoordinationLimits {
  readonly maxConcurrent: number;
  readonly maxTasks: number;
  readonly maxDurationMs?: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes?: number;
  readonly maxDepth?: number;
  readonly maxTaskTurns?: number;
  readonly maxMessages?: number;
  readonly maxMessageBytes?: number;
  readonly maxHandoffs?: number;
  readonly maxHandoffBytes?: number;
  /** Total attempts per task, including the initial attempt. */
  readonly maxAttempts?: number;
  readonly maxGraphChanges?: number;
  /** Per Run, not a shared token/cost budget. */
  readonly runBudget?: RunBudget;
}

export interface CoordinationSnapshot {
  readonly format: 1;
  readonly id: string;
  readonly revision: number;
  readonly policyVersion: string;
  readonly limits: CoordinationLimits;
  readonly startedAt?: number;
  readonly stopReason?: string;
  readonly tasks: readonly CoordinationTask[];
  /** Append-only envelopes; delivery reserves a message to exactly one turn. */
  readonly messages?: readonly TaskMessage[];
  readonly graphChanges?: readonly TaskGraphRevision[];
  /** Accepted host commands and their canonical payload, for idempotent retries. */
  readonly commands: Readonly<Record<string, string>>;
}

export interface TaskExecution {
  readonly coordinationId: string;
  readonly task: CoordinationTask;
  readonly dependencies: readonly { readonly taskId: string; readonly output: TaskOutput }[];
  readonly runBudget?: RunBudget;
  readonly messages?: readonly TaskMessage[];
  readonly wakeResults?: readonly { readonly taskId: string; readonly status: TaskStatus; readonly output?: TaskOutput; readonly detail?: string }[];
}

export interface TaskExecutionContext {
  readonly signal: AbortSignal;
  report(event: AgentApplicationEvent): void;
  /** Host-stamped task/turn identity; never accepted from model arguments. */
  delegate?(commandId: string, tasks: readonly TaskSpec[]): Promise<{ readonly taskIds: readonly string[] }>;
  sendMessage?(commandId: string, message: TaskMessageSpec): Promise<{ readonly messageId: string }>;
  waitForMessages?(commandId: string): Promise<void>;
  handoff?(commandId: string, handoff: HandoffSpec): Promise<{ readonly taskId: string; readonly agent: string }>;
}

export interface TaskYield { readonly yielded: true }

export type TaskRecovery =
  | { readonly status: "not-started" }
  | { readonly status: "completed"; readonly output: TaskOutput }
  | { readonly status: "yielded" }
  | { readonly status: "failed"; readonly detail: string }
  | { readonly status: "cancelled"; readonly detail: string }
  | { readonly status: "recovery-required"; readonly detail: string };

/** Trusted host adapter. recover must inspect durable evidence, never execute work. */
export interface CoordinationAgent {
  readonly version: string;
  execute(execution: TaskExecution, context: TaskExecutionContext): Promise<TaskOutput | TaskYield>;
  recover(execution: TaskExecution): Promise<TaskRecovery>;
  /** Idempotent control delivery for detached work; acceptance is not an outcome proof. */
  cancel?(execution: TaskExecution): Promise<void>;
  resolveApproval?(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<boolean>;
}

/** Policy callbacks run inside state serialization. Do not await commands on the same runtime. */
export interface CoordinationPolicy {
  /** Bump whenever execution authority or task routing changes. Checked on resume. */
  readonly version: string;
  authorize(task: Readonly<TaskSpec>, coordinationId: string): boolean | Promise<boolean>;
  /** Default deny. Approval of a delegation tool does not bypass this policy. */
  authorizeDelegation?(parent: Readonly<CoordinationTask>, child: Readonly<TaskSpec>, coordinationId: string): boolean | Promise<boolean>;
  /** Default deny, independent of the sender's tool permission. */
  authorizeMessage?(sender: Readonly<CoordinationTask>, recipient: Readonly<CoordinationTask>, message: Readonly<TaskMessageSpec>, coordinationId: string): boolean | Promise<boolean>;
  /** Default deny; checked at acceptance and before target dispatch. */
  authorizeHandoff?(source: Readonly<TaskController>, target: Readonly<TaskSpec>, input: string, coordinationId: string): boolean | Promise<boolean>;
  /** Default deny. The host explicitly accepts any known effects of the previous attempt. */
  authorizeRetry?(task: Readonly<CoordinationTask>, finding: string, coordinationId: string): boolean | Promise<boolean>;
  /** Default deny. Nodes and the entire resulting graph are validated independently. */
  authorizeGraphRewrite?(change: Readonly<TaskGraphChange>, snapshot: CoordinationSnapshot): boolean | Promise<boolean>;
}

export type CoordinationEvent =
  | { readonly type: "state.changed"; readonly snapshot: CoordinationSnapshot }
  | { readonly type: "agent.event"; readonly taskId: string; readonly sessionId: string; readonly event: AgentApplicationEvent }
  | { readonly type: "runtime.failed"; readonly message: string };

/** One exclusive writer per coordination; acknowledgement must be durable. */
export interface CoordinationJournal {
  read(): Promise<CoordinationSnapshot | undefined>;
  commit(snapshot: CoordinationSnapshot, expectedRevision: number): Promise<void>;
  close(): Promise<void>;
}

export interface CoordinationStore {
  acquire(id: string): Promise<CoordinationJournal>;
}
