import { randomUUID } from "node:crypto";
import { FatalToolExecutionError, RunCancelledError, type ToolExecution } from "@may/core";
import { GitCheckpointError, type GitCheckpoint, type GitRoundLease, type ProjectGitWorkspace } from "@may/application/git-workspace";
import type { AgentRun } from "@may/application";
import type { GoalRun, GoalRunOutcome } from "@may/goal";
import type { SessionEvent } from "@may/session";
import { defineService } from "@may/plugin";

export const gitRequestService = defineService<GitRequestController>({
  id: "maybecode.git-request", version: "1.0.0", scope: "application",
});

/** 一个请求的主 Agent、子 Agent 和 Goal 验证共用准备状态。 */
export class GitRequestController {
  private active: { sessionId: string; runId: string; preparation?: Promise<GitRoundLease | undefined> } | undefined;

  constructor(readonly workspace: ProjectGitWorkspace | undefined) {}

  begin(sessionId: string): void {
    if (this.active) throw new Error("A Git request is already active");
    this.active = { sessionId, runId: randomUUID() };
  }

  readonly beforeToolExecute = async (execution: ToolExecution): Promise<void> => {
    if (execution.tool.workspaceEffect === "read" || !this.workspace || this.workspace.readOnly) return;
    const request = this.active;
    if (!request) throw new FatalToolExecutionError("A workspace tool requires an active Git request");
    execution.context.signal.throwIfAborted();
    request.preparation ??= (async () => {
      if (!this.workspace!.autoCommit && !this.workspace!.repository) {
        await this.workspace!.summary();
        return undefined;
      }
      return this.workspace!.beginRound({ sessionId: request.sessionId, runId: request.runId });
    })();
    try { await request.preparation; }
    catch (error) { throw new FatalToolExecutionError("Git checkpoint preparation failed", { cause: error }); }
    execution.context.signal.throwIfAborted();
  };

  async lease(): Promise<GitRoundLease | undefined> { return this.active?.preparation; }

  async close(): Promise<void> {
    try { await this.active?.preparation?.then(lease => lease?.close(), () => undefined); }
    finally { this.active = undefined; }
  }
}

/** 一个用户请求的所有主 Run 和子任务共用一次工作区提交。 */
export async function startGitRequest<Run extends AgentRun>(
  request: GitRequestController,
  sessionId: string,
  start: () => Promise<Run>,
  changed: (checkpoint: GitCheckpoint) => void,
  position?: (runId: string) => Promise<number | undefined>,
  mainRunIds?: (firstRunId: string) => Promise<readonly string[]>,
): Promise<Run> {
  const git = request.workspace;
  request.begin(sessionId);
  let run: Run;
  try { run = await start(); }
  catch (error) { await request.close(); throw error; }
  const result = run.result.then(async value => {
    try {
      const lease = await request.lease();
      if (!lease) return value;
      const identity = await checkpointIdentity(run.id, mainRunIds);
      const saved = await lease.complete({ outcome: value.finishReason === "yielded" ? "failed" : "completed",
        ...identity });
      const checkpoint = await bindPosition(git!, saved, position);
      changed(checkpoint);
      return value;
    } catch (error) {
      if (error instanceof GitCheckpointError) changed(error.checkpoint);
      throw error;
    } finally { await request.close(); }
  }, async error => {
    try {
      const lease = await request.lease();
      if (lease) changed(await bindPosition(git!, await lease.complete({ outcome: error instanceof RunCancelledError ? "cancelled" : "failed", ...await checkpointIdentity(run.id, mainRunIds) }), position));
    }
    catch (checkpointError) {
      if (checkpointError instanceof GitCheckpointError) changed(checkpointError.checkpoint);
      throw new AggregateError([error, checkpointError], "Agent request and Git checkpoint failed", { cause: error });
    }
    finally { await request.close(); }
    throw error;
  });
  return { ...run, result };
}

/** Goal 验证完成之后结束文件处理，验证期间保留工作区互斥保护。 */
export async function startGitGoalRequest<Run extends AgentRun>(
  request: GitRequestController,
  sessionId: string,
  start: () => Promise<Run>,
  changed: (checkpoint: GitCheckpoint) => void,
  hostCompleted: (runId: string) => Promise<void>,
  position?: (runId: string) => Promise<number | undefined>,
  mainRunIds?: (firstRunId: string) => Promise<readonly string[]>,
): Promise<Run & GoalRun> {
  const git = request.workspace;
  request.begin(sessionId);
  let run: Run;
  try { run = await start(); }
  catch (error) { await request.close(); throw error; }
  let finalization: Promise<void> | undefined;
  const finalize = (outcome: GoalRunOutcome): Promise<void> => finalization ??= (async () => {
    try {
      const value = outcome === "completed" || outcome === "continued" ? await run.result : undefined;
      const lease = await request.lease();
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
    } finally { await request.close(); }
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
