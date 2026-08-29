import type {
  PermissionCheck,
  PermissionDecision,
  PermissionPolicy,
} from "@may/permissions";

export function createCodingPermissionPolicy(): PermissionPolicy {
  return (check) => defaultCodingPermission(check);
}

function defaultCodingPermission(check: PermissionCheck): PermissionDecision {
  if (check.tool.name === "read" || check.tool.name === "session_history") {
    return "allow";
  }

  if (check.tool.name === "bash") {
    const command = stringField(check.input, "command");
    return command === undefined
      ? "ask"
      : { decision: "ask", grantKey: `bash:${command}` };
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

  return "ask";
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null || !(name in value)) {
    return undefined;
  }
  const field = value[name as keyof typeof value];
  return typeof field === "string" && field !== "" ? field : undefined;
}
