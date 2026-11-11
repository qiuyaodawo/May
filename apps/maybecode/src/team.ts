import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileAccess } from "@sortedyuan/may/storage";
import type { MaybeCodeTeamCommand } from "./args.js";
import { getDefaultMaybeCodeDataDirectory } from "./configured.js";
import { MaybeCodeUsageError } from "./errors.js";
import type { RunMaybeCodeTeamDependencies } from "./team-common.js";

export type { RunMaybeCodeTeamDependencies } from "./team-common.js";

export async function runMaybeCodeTeamCommand(
  command: MaybeCodeTeamCommand,
  dependencies: RunMaybeCodeTeamDependencies,
): Promise<number> {
  if (command.action === "run") return (await import("./team-v2.js")).runTeamV2Command(command, dependencies);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(command.value)) throw new MaybeCodeUsageError("Invalid team id");
  const path = join(
    resolve(command.dataDirectory ?? getDefaultMaybeCodeDataDirectory()),
    "teams",
    command.value,
    "manifest.json",
  );
  const manifest = await withFileAccess(
    path,
    "shared",
    async () => JSON.parse(await readFile(path, "utf8")) as { version?: string },
  );
  if (manifest.version === "maybecode-team-v2")
    return (await import("./team-v2.js")).runTeamV2Command(command, dependencies);
  const action = command.action;
  if (action !== "resume" && action !== "status" && action !== "cancel")
    throw new MaybeCodeUsageError(
      "Legacy v1 teams retain read-only resume/status/cancel. New controls require a new v2 team; authority is never silently upgraded.",
    );
  return (await import("./team-v1.js")).runLegacyMaybeCodeTeamCommand({ ...command, action }, dependencies);
}
