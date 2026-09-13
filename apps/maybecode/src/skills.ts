import { MaybeCodeConfigError } from "./errors.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MayConfig } from "@may/config";

export function defaultMaybeCodeSkillDirectories(workspace: string, includeUser = true): readonly string[] {
  return [
    ...(includeUser ? [join(homedir(), ".agents", "skills"), join(homedir(), ".may", "skills")] : []),
    join(workspace, ".agents", "skills"), join(workspace, ".may", "skills"),
  ];
}

export function resolveMaybeCodeSkillDirectories(config: MayConfig, workspace: string): readonly string[] | false {
  const value = config.apps?.maybecode?.skills;
  if (value === false) return false;
  if (value === undefined) return defaultMaybeCodeSkillDirectories(workspace);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== "directories")) throw new MaybeCodeConfigError("apps.maybecode.skills must be false or {directories: string[]}");
  if (!("directories" in value)) return defaultMaybeCodeSkillDirectories(workspace);
  if (!Array.isArray(value.directories) || value.directories.length > 32 || value.directories.some((path) => typeof path !== "string" || path.trim() === "")) throw new MaybeCodeConfigError("skills.directories must contain at most 32 non-empty paths");
  return value.directories.map((path: string) => path === "~" ? homedir()
    : path.startsWith("~/") || path.startsWith("~\\") ? resolve(homedir(), path.slice(2)) : resolve(dirname(config.path), path));
}
