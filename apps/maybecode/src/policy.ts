import type {
  PermissionCheck,
  PermissionDecision,
  PermissionPolicy,
} from "@may/permissions";
import { resolveWritableWorkspacePath } from "@may/coding-tools";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";

export type MaybeCodePermissionMode = "default" | "yolo";

export function parsePermissionMode(value: unknown): MaybeCodePermissionMode {
  if (value === "default" || value === "yolo") return value;
  throw new TypeError('permissionMode must be "default" or "yolo"');
}

export function createCodingPermissionPolicy(options: {
  readonly mode?: () => MaybeCodePermissionMode;
  readonly readOnly?: boolean;
  readonly policy?: PermissionPolicy;
  readonly persistent?: { readonly workspace: string; readonly scopeId: string };
} = {}): PermissionPolicy {
  const policy = options.policy ?? defaultCodingPermission;
  return async (check) => {
    if (options.readOnly && !["read", "skill_read", "session_history", "session_history_search", "session_history_read", "get_context_remaining", "context_notes", "new_context", "get_goal"].includes(check.tool.name)) return "deny";
    let decision = await policy(check);
    if (options.persistent && ["read", "edit", "write"].includes(check.tool.name)) {
      const path = stringField(check.input, "path");
      if (path !== undefined) {
        const target = await resolveWritableWorkspacePath(options.persistent.workspace, path);
        const root = await realpath(options.persistent.workspace);
        const normalized = relative(root, target.absolute).replace(/\\/gu, "/");
        const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
        const rules = await resolveWritableWorkspacePath(options.persistent.workspace, ".may/permission-rules.json");
        const rulesRelative = relative(root, rules.absolute).replace(/\\/gu, "/");
        const rulesKey = process.platform === "win32" ? rulesRelative.toLowerCase() : rulesRelative;
        if (key === rulesKey || key.startsWith(`${rulesKey}.`)) return "deny";
        if (options.policy === undefined && check.tool.name !== "read" && decision !== "deny" && !(typeof decision === "object" && decision.decision === "deny")) {
          const scoped = typeof decision === "object" ? decision : { decision };
          const persistent = typeof decision === "object" ? decision.persistent : undefined;
          decision = {
            ...scoped,
            grantKey: persistent && typeof decision === "object" ? decision.grantKey : `${check.tool.name}:${key}`,
            persistent: persistent ?? { scopeId: options.persistent.scopeId, description: `${check.tool.name} · ${root} · ${key}` },
          };
        }
      }
    }
    const asks = decision === "ask" || (typeof decision === "object" && decision !== null &&
      decision.decision === "ask" && typeof decision.grantKey === "string" && decision.grantKey.trim() !== "");
    if (options.mode?.() === "yolo" && asks && !(typeof decision === "object" && decision.requireApproval)) {
      return typeof decision === "object" ? { ...decision, decision: "allow" } : "allow";
    }
    return decision;
  };
}

function defaultCodingPermission(check: PermissionCheck): PermissionDecision {
  if (["read", "skill_read", "session_history", "session_history_search", "session_history_read",
    "get_context_remaining", "context_notes", "new_context", "get_goal", "update_goal",
    "delegate_tasks"].includes(check.tool.name)) {
    // 委派是否被允许由宿主的角色授权决定：只有已注册且宿主授权的角色能被创建，
    // 超出授权范围的委派会在工具执行时失败。显式提供 deny 的自定义策略依然有效。
    return "allow";
  }

  if (check.tool.name === "shell" || check.tool.name === "bash") {
    const command = stringField(check.input, "command");
    return command === undefined
      ? "ask"
      : { decision: "ask", grantKey: `${check.tool.name}:${command}` };
  }

  if (check.tool.name === "edit" || check.tool.name === "write") {
    const path = stringField(check.input, "path");
    return path === undefined
      ? "ask"
      : {
          decision: "ask",
          grantKey: `${check.tool.name}:${path}`,
        };
  }

  if (check.tool.name.startsWith("mcp__")) {
    return {
      decision: "ask",
      grantKey: `mcp:${check.tool.name}`,
    };
  }

  return "ask";
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || !(name in value)) {
    return undefined;
  }
  const field = value[name as keyof typeof value];
  return typeof field === "string" && field !== "" ? field : undefined;
}
