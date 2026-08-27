import type {
  ToolDefinition,
  ToolExecutionContext,
} from "@may/core";

export type PermissionDecision = "allow" | "deny" | "ask";
export type ApprovalDecision = Exclude<PermissionDecision, "ask">;

export interface PermissionCheck {
  readonly tool: ToolDefinition;
  readonly input: unknown;
  readonly context: ToolExecutionContext;
}

export type PermissionPolicy = (
  check: PermissionCheck,
) => PermissionDecision | Promise<PermissionDecision>;

export interface ApprovalRequest extends PermissionCheck {
  readonly id: string;
  readonly createdAt: number;
}

export type PermissionEventPayload =
  | { type: "approval.requested"; request: ApprovalRequest }
  | {
      type: "approval.resolved";
      requestId: string;
      decision: ApprovalDecision;
    }
  | { type: "approval.cancelled"; requestId: string; reason?: string };

export type PermissionEvent = PermissionEventPayload & {
  seq: number;
  timestamp: number;
};
