import type { ToolDefinition, ToolExecutionContext } from "../core/index.js";
import type { PersistentPermissionRule } from "./rules.js";

/** @public */
export interface ScopedPermissionDecision {
  readonly decision: "allow" | "deny" | "ask";
  readonly grantKey: string;
  readonly persistent?: {
    readonly scopeId: string;
    readonly description: string;
  };
  readonly requireApproval?: boolean;
}

/** @public */
export interface ScopedPermissionAsk extends ScopedPermissionDecision {
  readonly decision: "ask";
}

/** @public */
export type PermissionDecision = "allow" | "deny" | "ask" | ScopedPermissionDecision;
/** @public */
export type ApprovalDecision = "allow" | "allow-session" | "allow-persistent" | "deny";

/** @public */
export interface ApprovalResolveOptions {
  readonly createdBy: string;
  readonly expiresAt?: number;
}

/** @public */
export type PersistentApprovalOptions = ApprovalResolveOptions;

/** @public */
export interface CreatePermissionRuleOptions extends ApprovalResolveOptions {
  readonly decision: "allow" | "deny";
}

/** @public */
export interface PermissionCheck {
  readonly tool: ToolDefinition & { readonly permissionVersion?: string };
  readonly input: unknown;
  readonly context: ToolExecutionContext;
}

/** @public */
export type PermissionPolicy = (check: PermissionCheck) => PermissionDecision | Promise<PermissionDecision>;

/** @public */
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

/** @public */
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

/** @public */
export type PermissionEvent = PermissionEventPayload & {
  seq: number;
  timestamp: number;
};

/** @public */
export type PermissionEventSink = (event: PermissionEvent) => void | Promise<void>;
