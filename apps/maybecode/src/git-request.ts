import { randomUUID } from "node:crypto";
import { RunCancelledError } from "@may/core";
import { GitCheckpointError, type GitCheckpoint, type ProjectGitWorkspace } from "@may/application/git-workspace";
import type { AgentRun } from "@may/application";
import type { GoalRun, GoalRunOutcome } from "@may/goal";
import type { SessionEvent } from "@may/session";

/** 一个用户请求的所有主 Run 和子任务共用一次工作区提交。 */
export async function startGitRequest<Run extends AgentRun>(
  git: ProjectGitWorkspace | undefined,
  sessionId: string,
  start: () => Promise<Run>,
  changed: (checkpoint: GitCheckpoint) => void,
  position?: (runId: string) => Promise<number | undefined>,
  mainRunIds?: (firstRunId: string) => Promise<readonly string[]>,
): Promise<Run> {
  if (!git || git.readOnly || (await git.status()).state === "unmanaged") return start();
  const lease = await git.beginRound({ sessionId, runId: randomUUID() });
  let run: Run;
  try { run = await start(); }
  catch (error) { await lease.close(); throw error; }
  const result = run.result.then(async value => {
    try {
      const identity = await checkpointIdentity(run.id, mainRunIds);
      const saved = await lease.complete({ outcome: value.finishReason === "yielded" ? "failed" : "completed",
        ...identity });
      const checkpoint = await bindPosition(git, saved, position);
      changed(checkpoint);
      return value;
    } catch (error) {
      if (error instanceof GitCheckpointError) changed(error.checkpoint);
      throw error;
    } finally { await lease.close(); }
  }, async error => {
    try { changed(await bindPosition(git, await lease.complete({ outcome: error instanceof RunCancelledError ? "cancelled" : "failed", ...await checkpointIdentity(run.id, mainRunIds) }), position)); }
    catch (checkpointError) {
      if (checkpointError instanceof GitCheckpointError) changed(checkpointError.checkpoint);
      throw new AggregateError([error, checkpointError], "Agent request and Git checkpoint failed", { cause: error });
    }
    finally { await lease.close(); }
    throw error;
  });
  return { ...run, result };
}

/** Goal 验证完成之后结束文件处理，验证期间保留工作区互斥保护。 */
export async function startGitGoalRequest<Run extends AgentRun>(
  git: ProjectGitWorkspace | undefined,
  sessionId: string,
  start: () => Promise<Run>,
  changed: (checkpoint: GitCheckpoint) => void,
  hostCompleted: (runId: string) => Promise<void>,
  position?: (runId: string) => Promise<number | undefined>,
  mainRunIds?: (firstRunId: string) => Promise<readonly string[]>,
): Promise<Run & GoalRun> {
  const managed = git !== undefined && !git.readOnly && (await git.status()).state !== "unmanaged";
  const lease = managed ? await git.beginRound({ sessionId, runId: randomUUID() }) : undefined;
  let run: Run;
  try { run = await start(); }
  catch (error) { await lease?.close(); throw error; }
  let finalization: Promise<void> | undefined;
  const finalize = (outcome: GoalRunOutcome): Promise<void> => finalization ??= (async () => {
    try {
      const value = outcome === "completed" || outcome === "continued" ? await run.result : undefined;
      if (lease) {
        const saved = await lease.complete({
          outcome: outcome === "completed" || outcome === "continued" && value?.finishReason !== "yielded" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed",
          ...await checkpointIdentity(run.id, mainRunIds),
        });
        if (outcome === "completed" && value?.finishReason === "yielded") {
          try { await hostCompleted(value.runId); }
          catch (error) { changed(saved); throw error; }
        }
        changed(await bindPosition(git!, saved, position));
      }
      else if (outcome === "completed" && value?.finishReason === "yielded") await hostCompleted(value.runId);
    } catch (error) {
      if (error instanceof GitCheckpointError) changed(error.checkpoint);
      throw error;
    } finally { await lease?.close(); }
  })();
  return { ...run, finalize };
}

/** Session history 保留失败和取消的主 Run 身份。 */
export function requestMainRunIds(history: readonly SessionEvent[], firstRunId: string): readonly string[] {
  const first = history.findIndex(event => event.type === "run.started" && event.runId === firstRunId);
  if (first < 0) throw new Error("The request's first main Run is missing from Session history");
  return history.slice(first).flatMap(event => event.type === "run.started" ? [event.runId] : []);
}

async function checkpointIdentity(firstRunId: string,
  read: ((firstRunId: string) => Promise<readonly string[]>) | undefined): Promise<{ runId: string; runIds: readonly string[] }> {
  const runIds = read ? await read(firstRunId) : [firstRunId];
  if (!runIds.length || runIds[0] !== firstRunId || new Set(runIds).size !== runIds.length) {
    throw new Error("The request's main Run identities are invalid");
  }
  return { runId: runIds[runIds.length - 1]!, runIds };
}

async function bindPosition(git: ProjectGitWorkspace, checkpoint: GitCheckpoint,
  position: ((runId: string) => Promise<number | undefined>) | undefined): Promise<GitCheckpoint> {
  if (!position || !checkpoint.runId) return checkpoint;
  const historyPosition = await position(checkpoint.runId);
  return historyPosition === undefined ? checkpoint : git.bindCheckpoint(checkpoint.id, historyPosition);
}
