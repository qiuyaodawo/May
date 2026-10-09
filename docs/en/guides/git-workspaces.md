# Git workspaces and file checkpoints

**English** | [简体中文](../../zh-CN/guides/git-workspaces.md)

`@may/application/git-workspace` provides the Node.js `ProjectGitWorkspace`
component. It requires Git 2.36 or newer on `PATH`. Applications supply their workspace and
commit authorization policy; the component supplies repository discovery,
durable file versions, diffs, restoration previews, and registered worktrees.

Use this guide when a host needs to associate complete user requests with file
versions and Session branches. It assumes the application already owns a
Session id and serializes workspace operations.

## Preparing a workspace

1. Confirm Git is available and the host has a trusted commit-approval callback.
2. Select `autoCommit` and `readOnly` according to the host's workflow.
3. Open the component and prepare the Session's initial file version.

With automatic management enabled, `prepare()` can commit existing changes.
The host must obtain the required user approval through `authorizeCommit`.
In this integration snippet, `sessionId` is the application's identity and
`confirmProjectCommit` is the host's actual approval function:

```ts
import { ProjectGitWorkspace } from "@may/application/git-workspace";

const files = await ProjectGitWorkspace.open({
  workspace: process.cwd(),
  authorizeCommit: request => confirmProjectCommit(request),
});
await files.prepare(sessionId);
```

`open()` discovers the containing repository, including projects opened inside
a repository subdirectory or linked worktree. A project without Git is
initialized when automatic management is enabled. `prepare()` captures initial
uncommitted project changes, including existing staged changes whose working
content matches the index. Git uses the project's effective author identity,
Hooks, ignore rules, attributes, and signing configuration. The component never
changes these settings. Identity, signing, or Hook failures stop preparation.

`autoCommit` defaults to `true`. `autoCommit: false` observes existing versions
and preserves uncommitted changes. `readOnly: true` neither initializes a
repository nor creates versions or state files. A host can use `status()` to
handle an unmanaged read-only workspace. Git's `GIT_CEILING_DIRECTORIES`
discovery boundary is respected.

The containing repository is the commit scope. Configured `excludedPaths` are
repository-relative paths or absolute paths inside that repository. Git ignored
files are omitted. Automatic management excludes `.env`, `.env.*` except
`.env.example`, `credentials.json`, common private-key files, `secrets.json`,
`secrets.yaml`, `secrets.yml`, and `.pem`, `.p12`, `.pfx`, `.key` files. Excluded
files already staged cause an explicit error. Applications must configure
additional exclusions for project-specific credential files. Conflicting
staged and working versions, unresolved conflicts, active merge/rebase/history
operations, submodules, and changed nested repositories require resolution
before automatic commits.

## Completing a request

Use `beginRound()` before accepting file changes for a request. Keep the returned
lease until work and verification finish. The following snippet assumes the host
implements `processCompleteUserRequest()` and `associateCheckpoint()`:

```ts
const lease = await files.beginRound({ sessionId });
try {
  const result = await processCompleteUserRequest();
  const checkpoint = await lease.complete({
    outcome: "completed",
    runId: result.runId,
    runIds: result.runIds,
    historyPosition: result.historyPosition,
    commitMessage: "Update project configuration",
  });
  await associateCheckpoint(checkpoint);
} finally {
  await lease.close();
}
```

A lease covers all file changes and checks in one complete user request. It
uses an exclusive filesystem lock for the repository working directory,
including across processes. Independent linked worktrees have separate locks.
The first round of a Session prepares its initial version if needed.
`complete()` releases the lock, and `close()` is idempotent. Hosts call
`complete({ outcome: "failed" })` or `complete({ outcome: "cancelled" })` to
record incomplete work and preserve its edits.
MaybeCode failure and cancellation checkpoints retain every main Run identity
in the request and use the final main Run as `runId`, so the final reply can
still display that request's file changes.
MaybeCode Goal Runs retain their lease through host verification. Their optional
`finalize(outcome)` callback saves an accepted completed Goal's final file version
and host-confirmed Session position. Verification failure or cancellation retains
uncommitted edits and releases the lease. A Run result can finish before this
callback so the Goal controller can perform verification without waiting on itself.

Successful completion creates at most one commit, using an English message.
A round without eligible changes associates its existing commit. Checkpoints
include their start and end commit, branch, workspace, Session, request Run
identities, optional history position, and `committed`, `unchanged`,
`uncommitted`, or `failed` status. `GitCheckpointError.checkpoint` describes a
failed operation, including an applied commit when available.
After committing, eligible staged and working changes are checked again. Hook
edits or other concurrent writes produce a failed partial checkpoint with the
created commit preserved; remaining changes stay in the workspace.

`checkpoints(sessionId?)`, `checkpoint(id)`, and
`checkpointByRun(sessionId, runId)` read saved records. `bindCheckpoint(id,
historyPosition)` associates the terminal persisted Session position after the
file version is saved. `status()` reports the actual current branch, detached
HEAD, unborn repository, and uncommitted changes. Historical branch labels
remain in checkpoint records.
Status and diff reads use a separate Git client, keeping them available while
a project Hook or signing process is completing a commit.

State records default to `~/.may/git-workspaces/<projectId>/`. Both this storage
and configurable worktree storage must remain outside the source repository.
Each saved version and its comparison start have protected
`refs/may/checkpoints/` and `refs/may/checkpoint-starts/` references. Closing or
deleting a Session keeps these references and project commits. There is no
automatic checkpoint expiration.

A durable intent records the prepared Git tree before committing and the
applied commit before saving the checkpoint. Reopening recovers a completed
commit instead of creating it again. Ambiguous intervening Git history produces
an explicit inspection error. An exited lock owner can be recovered; active,
foreign-host, and invalid lock owners remain protected.

## Comparing and restoring files

For restoration, perform these host actions in order:

1. Select a checkpoint and explicit files.
2. Call `previewRestore()` and display its current and target contents.
3. Obtain the required restoration authorization.
4. Call `restore(preview)` and report its checkpoint or partial failure.

`diff({ from, to?, file? })` compares two commits, or a commit with current
working contents when `to` is omitted. It provides unified patches, per-file
status and patch, rename source paths, binary markers, line counts, and
untracked files. Excluded credential paths are omitted from generated diffs.

`previewRestore({ checkpointId, paths })` requires an explicit file selection.
It returns the reviewed current-content fingerprints and target contents.
`restore(preview)` verifies every fingerprint before making changes and checks
each path again while writing. It supports regular files and prevents access
through symbolic-link parents or Git metadata. Restoration reads Git objects
and uses ordinary filesystem writes and deletions. Binary files keep their
exact content. A concurrent edit stops restoration with an explicit conflict.
`GitWorkspaceConflictError` exposes safe state-conflict messages for changed
restoration fingerprints, competing writers, and protected worktree deletion.
Hosts must display the preview and obtain the required authorization before
calling restoration.

`restore(preview, { sessionId, runId?, historyPosition?, commitMessage? })`
restores the selected files and saves the resulting checkpoint under the same
exclusive lock. Filesystem failures can leave a partially completed restoration;
the host must report the failure and preserve the preview for inspection.

## Managing worktrees

`createWorktree({ sessionId, historyPosition, checkpointId })` creates a new
Git branch and worktree using the selected checkpoint's exact commit. The
default directory is `~/.may/worktrees/<projectId>/<worktreeId>`, configurable
with `worktreesRoot`. A subdirectory project keeps the same relative project
directory inside the new worktree. The result records source Session and
position, commit, path, branch, associated Sessions/processes, and lifecycle
status. Partial creation preserves its registration and diagnostic.

`listWorktrees()` returns May-registered worktrees.
`attachWorktreeSession(id, sessionId, attached?)` and
`trackWorktreeProcess(id, pid, attached?)` maintain lifecycle associations.
`failWorktree(id, error)` records a failed application/Session attachment while
preserving the newly created directory and branch.

`deleteWorktree(id)` checks registration, directory identity, containing Git
repository, associated Sessions, running registered processes, tracked,
untracked and ignored files, branch identity, and commits not included in the
source workspace. It deletes a clean unreferenced worktree and its merged
branch. The history comparison always uses the registered source workspace,
including when management is requested from another linked worktree. A failed
registration whose directory and Git branch were never
created can also be removed. Closing a Session leaves its worktree intact;
deleting a Session and deleting a worktree are independent host operations.

MaybeCode rebuilds tools and Skills for a selected worktree. Configured MCP stdio
working directories inside the project follow that directory; external absolute
directories keep their configured location. Each workspace owns its connections,
and returning to it reuses them. MCP host roots identify the active workspace.
Closing the MaybeCode host releases every workspace's connections.
Resource subscriptions belong to their workspace and Session. Identical server
IDs and resource URIs in another workspace create an independent subscription;
only the active owner receives subscription notifications.

MaybeCode treats fork preparation, worktree changes, file restoration and Session
switching as active workspace operations. New input and other state changes are
rejected throughout these operations, including while Git Hooks or signing wait.
Closing the host waits for an accepted workspace operation to finish before
closing its application and owned resources. Failed restoration retains its
preview for inspection and reports any failed Git checkpoint.

## Verify the integration

Confirm that `status()` reports the selected directory and current repository
state, a completed request has a checkpoint, and `diff()` describes that
request's files. Test failure and cancellation with edits preserved. Verify
restoration through explicit previews and check worktree lifecycle associations.

Run the real-Git integration suite only with authorization for commits inside
its isolated test repositories:

```powershell
$env:MAY_GIT_CHECKPOINT_TEST_COMMITS = '1'
pnpm --filter @may/application build
node --test packages/application/test/git-workspace*.test.mjs
```

The fixtures reside in the ignored `review/git-workspace-tests/` directory.
Each writable fixture initializes and validates its own repository before
configuring test identity. Production repository identity and index are kept
outside fixture operations.

The independent package-consumer check packs the complete runtime dependency
chain, installs it offline from tarballs, and exercises the published Git
subpath:

```powershell
$env:MAY_GIT_PACKAGE_TEST = '1'
$env:MAY_GIT_CHECKPOINT_TEST_COMMITS = '1'
pnpm --filter @may/application test:package
```
