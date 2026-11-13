import { join } from "node:path";
import type {
  CoordinationRuntime,
  CoordinationSnapshot,
  FileSharedBudget,
  TaskExecution,
  TaskWorkspaceManager,
} from "@sortedyuan/coordination";
import type { MaybeCodeTeamCommand } from "./args.js";
import type { TeamAcceptance, TeamVerificationStore } from "./team-verification.js";
import { applyTeamPatch, createTeamPatch, readTeamPatch } from "./team-patches.js";
import { renderTeamPatchDiff } from "./team-patch-bundle.js";
import { writeJson, type Manifest } from "./team-v2-manifest.js";

export async function runTeamPatchCommand(options: {
  readonly command: MaybeCodeTeamCommand;
  readonly manifest: Manifest;
  readonly directory: string;
  readonly runtime: CoordinationRuntime;
  readonly ledger: FileSharedBudget;
  readonly workspaces: TaskWorkspaceManager;
  readonly verification: TeamVerificationStore;
  readonly write: (text: string) => void;
}): Promise<number> {
  const { command, manifest, directory, runtime, ledger, workspaces, verification, write } = options;
  if (manifest.mode !== "coding")
    throw new Error("Patch controls require a team explicitly created with --mode coding");
  const state = runtime.snapshot();
  if (state.tasks.some((task) => !["completed", "failed", "cancelled"].includes(task.status)))
    throw new Error("Settle all active/unknown team work before reviewing or applying a patch");
  if (command.action === "diff") {
    const taskIds = command.tasks!.split(",");
    if (
      !taskIds.length ||
      new Set(taskIds).size !== taskIds.length ||
      taskIds.some((id) => state.tasks.find((task) => task.id === id)?.status !== "completed")
    )
      throw new Error("Select distinct completed task ids for review");
    const patch = await createTeamPatch({ directory, workspaces, taskIds });
    write(renderTeamPatchDiff(patch));
    write(
      `\nPatch: ${patch.id}\nReview digest: ${patch.digest}\nOnly use team apply after reviewing the diff and current acceptance.\n`,
    );
    return 0;
  }
  const patch = await readTeamPatch(directory, command.patch!);
  const uncheckedTasks = patch.taskSnapshots
    .map((task) => task.taskId)
    .filter((taskId) => !manifest.plan.checks.some((check) => check.taskId === taskId));
  if (uncheckedTasks.length)
    write(
      `Unverified patch tasks (human review only): ${uncheckedTasks.join(", ")}. Other tasks' passing checks do not verify these edits.\n`,
    );
  if (
    (await ledger.totals()).blocked ||
    (await verification.snapshot()).checks.some((check) => ["pending", "unknown"].includes(check.status))
  )
    throw new Error("Reconcile unknown team effects before applying source changes");
  for (const checkTaskId of new Set(manifest.plan.checks.map((check) => check.taskId))) {
    const task = state.tasks.find((task) => task.id === checkTaskId);
    if (task?.status !== "completed")
      throw new Error("All configured acceptance tasks must complete before source application");
    const workspace = await workspaces.prepare(checkTaskId);
    if (
      (await verification.acceptance(checkTaskId, workspace.directory, executionOf(state, checkTaskId))).status !==
      "passed"
    )
      throw new Error(`Acceptance is not passed/current for ${checkTaskId}; use team verify and inspect reports`);
  }
  if (!manifest.plan.checks.length)
    write("No configured acceptance checks: this is an explicit human-reviewed, unverified source application.\n");
  const result = await applyTeamPatch({
    directory,
    workspaces,
    patchId: patch.id,
    confirmDigest: command.confirm!,
  });
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === "applied" ? 0 : 1;
}

export function executionOf(state: CoordinationSnapshot, taskId: string): TaskExecution {
  const task = state.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error("Unknown task");
  return { coordinationId: state.id, task, dependencies: [] };
}

export async function summarizeAcceptance(
  directory: string,
  state: CoordinationSnapshot,
  manifest: Manifest,
  workspaces: TaskWorkspaceManager,
  verification: TeamVerificationStore,
) {
  const tasks: Record<string, Omit<TeamAcceptance, "report">> = {};
  for (const task of state.tasks)
    if (task.status === "completed") {
      const workspace = await workspaces.prepare(task.id);
      const { report: _report, ...acceptance } = await verification.acceptance(
        task.id,
        workspace.directory,
        executionOf(state, task.id),
      );
      tasks[task.id] = acceptance;
    }
  const required = [...new Set(manifest.plan.checks.map((check) => check.taskId))];
  const failed = Object.values(tasks).some((task) => task.status === "failed");
  const status = failed
    ? "failed"
    : required.length &&
        state.tasks.every((task) => task.status === "completed") &&
        required.every((id) => tasks[id]?.status === "passed")
      ? "passed"
      : "unverified";
  const result = {
    format: 1,
    revision: state.revision,
    status,
    tasks,
    note: "Scoped configured checks only, not proof of every natural-language claim. Verify rechecks exact workspace fingerprints.",
  };
  await writeJson(join(directory, "acceptance.json"), result);
  return result;
}
