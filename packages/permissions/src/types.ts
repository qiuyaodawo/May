import type {
  ToolDefinition,
  ToolExecutionContext,
} from "@may/core";
import type { PersistentPermissionRule } from "./rules.js";

export interface ScopedPermissionDecision {
  readonly decision: "allow" | "deny" | "ask";
  readonly grantKey: string;
  readonly persistent?: {
    readonly scopeId: string;
    readonly description: string;
  };
  readonly requireApproval?: boolean;
}

export interface ScopedPermissionAsk extends ScopedPermissionDecision {
  readonly decision: "ask";
}

export type PermissionDecision =
  | "allow"
  | "deny"
  | "ask"
  | ScopedPermissionDecision;
export type ApprovalDecision = "allow" | "allow-session" | "allow-persistent" | "deny";

export interface ApprovalResolveOptions {
  readonly createdBy: string;
  readonly expiresAt?: number;
}

export type PersistentApprovalOptions = ApprovalResolveOptions;

export interface CreatePermissionRuleOptions extends ApprovalResolveOptions {
  readonly decision: "allow" | "deny";
}

export interface PermissionCheck {
  readonly tool: ToolDefinition & { readonly permissionVersion?: string };
  readonly input: unknown;
  readonly context: ToolExecutionContext;
}

export type PermissionPolicy = (
  check: PermissionCheck,
) => PermissionDecision | Promise<PermissionDecision>;

export interface ApprovalRequest extends PermissionCheck {
  readonly id: string;
  readonly createdAt: number;
  readonly grantKey?: string;
  readonly persistent?: {
    readonly scopeId: string;
    readonly description: string;
    readonly definitionKey: string;
  };
}

export type PermissionEventPayload =
  | { type: "approval.requested"; request: ApprovalRequest }
  | {
      type: "approval.resolved";
      requestId: string;
      decision: ApprovalDecision;
    }
  | { type: "approval.cancelled"; requestId: string; reason?: string }
  | { type: "rule.created"; rule: PersistentPermissionRule }
  | { type: "rule.revoked"; ruleId: string; scopeId: string }
  | {
      type: "rule.used";
      ruleId: string;
      scopeId: string;
      decision: "allow" | "deny";
      runId: string;
      toolCallId: string;
    };

export type PermissionEvent = PermissionEventPayload & {
  seq: number;
  timestamp: number;
};

export type PermissionEventSink = (
  event: PermissionEvent,
) => void | Promise<void>;
