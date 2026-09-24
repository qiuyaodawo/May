import type { ContinueOptions, RunOptions, RunResult } from "@may/core";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled" | "failed" | "budget_exhausted";

export interface GoalBudget {
  readonly maxRuns?: number;
  readonly maxTotalTokens?: number;
  readonly maxDurationMs?: number;
}

export interface GoalCall {
  readonly id: string;
  readonly runId?: string;
  readonly status: "pending" | "settled" | "unknown";
  readonly tokens?: number;
}

export interface GoalState {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly budget: GoalBudget;
  readonly usage: { readonly runs: number; readonly totalTokens: number; readonly elapsedMs: number; readonly usageComplete: boolean };
  readonly calls: readonly GoalCall[];
  readonly runIds: readonly string[];
  readonly progress: string;
  readonly reason?: string;
  readonly report?: { readonly status: "completed" | "blocked"; readonly evidence: string };
  readonly completion?: { readonly source: "model" | "verifier"; readonly evidence: string };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GoalStore {
  read(): Promise<unknown>;
  write(state: GoalState): Promise<void>;
}

export interface GoalRun {
  readonly id: string;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): void;
}

export interface GoalAgent {
  readonly sessionId: string;
  readonly isRunning: boolean;
  submit(options: Omit<RunOptions, "stepInputSource">): Promise<GoalRun>;
  continue(options: Omit<ContinueOptions, "stepInputSource">): Promise<GoalRun>;
}

export interface GoalOptions {
  readonly verify?: (state: GoalState, signal: AbortSignal) => Promise<{ readonly completed: boolean; readonly evidence: string }>;
  readonly validateBudget?: (budget: GoalBudget) => void;
}

export interface GoalEvent {
  readonly type: "goal.changed";
  readonly goal: GoalState;
}
