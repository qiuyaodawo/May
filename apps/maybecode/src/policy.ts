import type {
  PermissionCheck,
  PermissionDecision,
  PermissionPolicy,
} from "@may/permissions";

export type MaybeCodePermissionMode = "default" | "yolo";

export function parsePermissionMode(value: unknown): MaybeCodePermissionMode {
  if (value === "default" || value === "yolo") return value;
  throw new TypeError('permissionMode must be "default" or "yolo"');
}

export function createCodingPermissionPolicy(options: {
  readonly mode?: () => MaybeCodePermissionMode;
  readonly policy?: PermissionPolicy;
} = {}): PermissionPolicy {
  const policy = options.policy ?? defaultCodingPermission;
  return async (check) => {
    const decision = await policy(check);
    const asks = decision === "ask" || (typeof decision === "object" && decision !== null &&
      decision.decision === "ask" && typeof decision.grantKey === "string" && decision.grantKey.trim() !== "");
    return options.mode?.() === "yolo" && asks ? "allow" : decision;
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
