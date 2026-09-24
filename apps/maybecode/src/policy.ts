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
    "get_context_remaining", "context_notes", "new_context", "get_goal", "update_goal"].includes(check.tool.name)) {
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
