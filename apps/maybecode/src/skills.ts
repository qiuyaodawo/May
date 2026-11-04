import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MayConfig } from "@sortedyuan/may/config";
import { readMaybeCodeSettings } from "./settings.js";

export function defaultMaybeCodeSkillDirectories(workspace: string, includeUser = true): readonly string[] {
  return [
    ...(includeUser ? [join(homedir(), ".agents", "skills"), join(homedir(), ".may", "skills")] : []),
    join(workspace, ".agents", "skills"),
    join(workspace, ".may", "skills"),
  ];
}

export function resolveMaybeCodeSkillDirectories(config: MayConfig, workspace: string): readonly string[] | false {
  const value = readMaybeCodeSettings(config).skills;
  if (value === false) return false;
  if (value?.directories === undefined) return defaultMaybeCodeSkillDirectories(workspace);
  return value.directories.map((path) =>
    path === "~"
      ? homedir()
      : path.startsWith("~/") || path.startsWith("~\\")
        ? resolve(homedir(), path.slice(2))
        : resolve(dirname(config.path), path),
  );
}
