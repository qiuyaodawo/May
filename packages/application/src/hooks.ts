import {
  defineHook,
  validateMessage,
  type HookDefinition,
  type SerializedError,
  type UserMessage,
  type ToolExecutionContext,
} from "@may/core";
import type { ApprovalRequest, PermissionEvent } from "@may/permissions";
import type { ContextCompactionResult } from "@may/context";

export interface ApplicationOpeningHook {
  readonly sessionId: string;
  readonly resume: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
  readonly instructions?: string;
}

export interface ApplicationIdentityHook {
  readonly sessionId: string;
}

export interface InputHook {
  readonly input: string | UserMessage;
  readonly inputId?: string;
  readonly steering?: boolean;
}

export interface CompactionHook {
  readonly strategy?: string;
  readonly automatic: boolean;
}

export interface CompactionFailureHook extends CompactionHook {
  readonly error: SerializedError;
}

export interface RecoveryHook {
  readonly id: string;
  readonly finding: string;
}

export type ApplicationApprovalEvent = Exclude<PermissionEvent, { readonly type: "approval.requested" }> | {
  readonly type: "approval.requested";
  readonly seq: number;
  readonly timestamp: number;
  readonly request: Omit<ApprovalRequest, "context"> & {
    readonly context: Pick<ToolExecutionContext, "runId" | "step" | "toolCallId" | "idempotencyKey" | "scope" | "traceContext">;
  };
};

export const applicationHooks = Object.freeze({
  beforeCreate: defineHook<ApplicationOpeningHook>({ name: "application.beforeCreate", kind: "transform", validate: validateOpening }),
  created: defineHook<ApplicationIdentityHook>({ name: "application.created", kind: "observe", validate: validateIdentity }),
  beforeClose: defineHook<ApplicationIdentityHook>({ name: "application.beforeClose", kind: "observe", validate: validateIdentity, allowAborted: true }),
  closed: defineHook<ApplicationIdentityHook>({ name: "application.closed", kind: "observe", validate: validateIdentity, allowAborted: true }),
  inputReceived: defineHook<InputHook>({ name: "input.received", kind: "observe", validate: validateInput }),
  inputBeforeSubmit: defineHook<InputHook>({ name: "input.beforeSubmit", kind: "transform", validate: validateInput }),
  inputSubmitted: defineHook<InputHook & { readonly runId?: string }>({ name: "input.submitted", kind: "observe", validate: validateInput }),
  compactionBefore: defineHook<CompactionHook>({ name: "compaction.before", kind: "transform", validate: validateCompaction }),
  compactionCompleted: defineHook<ContextCompactionResult & { readonly automatic: boolean }>({ name: "compaction.completed", kind: "observe", validate: validateCompactionResult }),
  compactionFailed: defineHook<CompactionFailureHook>({ name: "compaction.failed", kind: "observe", validate: validateCompactionFailure, allowAborted: true }),
  approvalRequested: defineHook<ApplicationApprovalEvent>({ name: "approval.requested", kind: "observe", validate: validatePermission }),
  approvalResolved: defineHook<ApplicationApprovalEvent>({ name: "approval.resolved", kind: "observe", validate: validatePermission, allowAborted: true }),
  recoveryBefore: defineHook<RecoveryHook>({ name: "recovery.before", kind: "transform", validate: validateRecovery }),
  recoveryResolved: defineHook<RecoveryHook>({ name: "recovery.resolved", kind: "observe", validate: validateRecovery }),
});

export const APPLICATION_HOOKS: readonly HookDefinition<unknown>[] = Object.freeze(Object.values(applicationHooks));

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Hook payload must be an object");
  return value as Record<string, unknown>;
}

function validateIdentity(value: unknown): ApplicationIdentityHook {
  const data = record(value);
  if (typeof data.sessionId !== "string" || data.sessionId.trim() === "") throw new TypeError("Hook requires sessionId");
  return value as ApplicationIdentityHook;
}

function validateOpening(value: unknown): ApplicationOpeningHook {
  validateIdentity(value);
  const data = record(value);
  if (typeof data.resume !== "boolean") throw new TypeError("resume must be boolean");
  if (data.metadata !== undefined) record(data.metadata);
  if (data.contextMetadata !== undefined) record(data.contextMetadata);
  if (data.instructions !== undefined && typeof data.instructions !== "string") throw new TypeError("instructions must be a string");
  return value as ApplicationOpeningHook;
}

function validateInput(value: unknown): InputHook {
  const data = record(value);
  if (typeof data.input !== "string" && validateMessage(data.input).role !== "user") throw new TypeError("Input requires user message");
  if (data.inputId !== undefined && (typeof data.inputId !== "string" || data.inputId.trim() === "")) throw new TypeError("inputId must be a non-empty string");
  if (data.steering !== undefined && typeof data.steering !== "boolean") throw new TypeError("steering must be boolean");
  return value as InputHook;
}

function validateCompaction(value: unknown): CompactionHook {
  const data = record(value);
  if (data.strategy !== undefined && (typeof data.strategy !== "string" || data.strategy.trim() === "")) throw new TypeError("Compaction strategy must be a non-empty string");
  if (typeof data.automatic !== "boolean") throw new TypeError("automatic must be boolean");
  return value as CompactionHook;
}

function validateCompactionResult(value: unknown): ContextCompactionResult & { readonly automatic: boolean } {
  validateCompaction(value);
  const data = record(value);
  if (typeof data.changed !== "boolean" || !Array.isArray(data.messages)) throw new TypeError("Invalid compaction result");
  for (const message of data.messages) validateMessage(message);
  record(data.before);
  record(data.after);
  return value as ContextCompactionResult & { readonly automatic: boolean };
}

function validateCompactionFailure(value: unknown): CompactionFailureHook {
  validateCompaction(value);
  const error = record(record(value).error);
  if (typeof error.name !== "string" || typeof error.message !== "string") throw new TypeError("Invalid compaction error");
  return value as CompactionFailureHook;
}

function validatePermission(value: unknown): ApplicationApprovalEvent {
  const data = record(value);
  if (typeof data.type !== "string" || !data.type.startsWith("approval.")) throw new TypeError("Invalid approval event");
  return value as ApplicationApprovalEvent;
}

function validateRecovery(value: unknown): RecoveryHook {
  const data = record(value);
  if (typeof data.id !== "string" || data.id.trim() === "") throw new TypeError("Recovery requires id");
  if (typeof data.finding !== "string" || data.finding.trim() === "" || data.finding.length > 32768) throw new TypeError("Recovery finding must contain 1-32768 characters");
  return value as RecoveryHook;
}
