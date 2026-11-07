import type { GitCheckpoint, ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import type { UiForkPoint } from "@sortedyuan/ui-client";
import type { BaseWorkspace } from "./workspace-state.js";

export async function workspaceForkPoints(
  manager: BaseWorkspace,
  getGit: () => ProjectGitWorkspace | undefined,
  listSessions: () => Promise<readonly SessionSummary[]>,
  sessionId?: string,
): Promise<readonly UiForkPoint[]> {
  const nodes = await manager.readSessionBranchTree();
  const checkpoints = (await getGit()?.checkpoints()) ?? [];
  const sessions = await listSessions();
  const worktrees = (await getGit()?.listWorktrees()) ?? [];
  const checkpointFor = (sourceId: string, runId: string): GitCheckpoint | undefined => {
    const seen = new Set<string>();
    while (!seen.has(sourceId)) {
      seen.add(sourceId);
      const checkpoint = [...checkpoints]
        .reverse()
        .find((item) => item.sessionId === sourceId && (item.runId === runId || item.runIds?.includes(runId)));
      if (checkpoint) return checkpoint;
      const source = nodes.find((node) => node.sessionId === sourceId)?.fork;
      if (!source) return undefined;
      sourceId = source.sessionId;
    }
    throw new Error("Session branch lineage contains a cycle");
  };
  return nodes.flatMap((node) => {
    if (sessionId && node.sessionId !== sessionId) return [];
    const workspace = sessions.find((session) => session.id === node.sessionId)?.workspace;
    const worktree = worktrees.find((tree) => tree.workspace === workspace);
    const workspaceReady = worktree === undefined || worktree.status === "ready";
    return node.positions.map((position, index) => {
      const checkpoint = checkpointFor(node.sessionId, position.runId);
      const completeRequest = checkpoint?.runIds?.length ? checkpoint.runId === position.runId : true;
      const parent = index ? node.positions[index - 1] : undefined;
      return {
        id: `${node.sessionId}:${position.positionSeq}`,
        sessionId: node.sessionId,
        runId: position.runId,
        createdAt: position.timestamp,
        userPreview: position.request,
        assistantPreview: position.response,
        available: position.available && completeRequest && workspaceReady,
        ...(!workspaceReady
          ? { reason: "The managed worktree did not finish initialization; inspect its diagnostic" }
          : !completeRequest
            ? { reason: "The selected Run belongs to an unfinished part of this request" }
            : position.reason
              ? { reason: position.reason }
              : {}),
        ...(parent
          ? { parentPointId: `${node.sessionId}:${parent.positionSeq}` }
          : node.fork
            ? { parentPointId: `${node.fork.sessionId}:${node.fork.positionSeq}` }
            : {}),
        ...(checkpoint?.commit ? { commit: checkpoint.commit } : {}),
        ...(checkpoint?.branch ? { branch: checkpoint.branch } : {}),
        worktreeAvailable:
          position.available &&
          completeRequest &&
          workspaceReady &&
          getGit()?.readOnly !== true &&
          checkpoint?.commit !== undefined &&
          ["committed", "unchanged"].includes(checkpoint.status),
      };
    });
  });
}
