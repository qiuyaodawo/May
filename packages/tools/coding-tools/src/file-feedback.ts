import type { WorkspacePath } from "./workspace-path.js";

/** @experimental */
export interface WorkspaceDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
}

/** @experimental */
export interface WorkspaceFileFeedbackResult {
  readonly diagnostics: {
    readonly status: "complete" | "pending" | "unknown" | "unavailable";
    readonly reason?: string;
    readonly receivedAt?: string;
    readonly items: readonly WorkspaceDiagnostic[];
    readonly truncated: boolean;
  };
}

/** @experimental */
export interface WorkspaceFileFeedbackTicket {
  /** Called after the file lock is released. */
  result(signal: AbortSignal): Promise<WorkspaceFileFeedbackResult>;
}

/** @experimental */
export interface WorkspaceFileFeedback {
  /** Called inside the file lock after writing. Must not await I/O. */
  record(path: WorkspacePath, content: string): WorkspaceFileFeedbackTicket | undefined;
}
