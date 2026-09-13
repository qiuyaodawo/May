# Controlled multi-agent coding

[简体中文](../../zh-CN/guides/maybecode-team-coding.md)

Coding teams edit **independent task copies**, not a shared source checkout. The host can bind the existing `read`, `write`, and `edit` tools to each prepared workspace. A model may propose and edit files in its copy, but it cannot authorize source application. Source changes require a separate, explicit host command with the exact digest of a reviewed patch.

## Review and apply

Start an explicitly authorized coding run with `maybecode team run "Implement the requested change in your private copy" --mode coding --workspace <path>`. The default coding preset grants `write`/`edit` only to its worker role; the supervisor remains read-only. A custom `--plan <json>` must also list the appropriate tools for each editing role. The plan cannot turn on coding mode by itself.

After the selected tasks have stopped, capture their changes:

```powershell
maybecode team diff <team-id> --tasks worker-a,worker-b
```

The command saves an immutable patch bundle and prints its ID, confirmation digest, task identities, and unified diff. Use the same `--data-directory` as the original team when it is non-default. Review the complete diff and any conflict markers before applying:

```powershell
maybecode team apply <team-id> --patch <patch-id> --confirm <exact-digest>
```

The confirmation is bound to the full bundle, including the source baseline, selected task snapshots, changed paths, and before/after content hashes. A generic `yes`, a task ID, or a stale digest is not confirmation. Do not put the apply command in a model tool or have a model manufacture user approval.

If several tasks produce exactly the same change to the same file, the bundle keeps one change with all contributing task IDs. Different results for the same path are a conflict, including edit-versus-delete; no arbitrary winner or text merge is chosen. The preview includes each candidate and application is blocked. Select a non-conflicting task set or resolve the changes in a task copy, then create and review a new bundle.

## What application checks

Before the first source-content write, application verifies:

- The exact bundle digest and the absence of task conflicts.
- The immutable baseline and every included file in each selected task snapshot still match the review. Task drift requires a new patch, even if the changed file is not itself being applied.
- Every affected source file still has its baseline hash, and added paths are still absent. All files are checked before changing the first one, so a conflict on a later file does not cause an earlier partial write.
- Paths stay inside the canonical source root. Symbolic-link parents, symbolic/hard-linked files, special files, path aliases, directory/file overlap, nonportable names, and oversized or non-UTF-8 patch content are rejected.
- A cooperative, per-source exclusive lock is available. The lock is under `~/.may/maybecode/apply-locks/`, independent of team IDs and custom data roots. A stale lock is never stolen automatically.

Task patch snapshots cover the workspace manager's **included source tree**. Its normal hidden/secret/build exclusions remain in effect; excluded files are never merged. Verification reports may additionally bind the entire task directory. A previous successful check must not be reused after files relevant to that check change; patch application itself does not execute a test or certify the code.

Default patch bounds are 128 changed-file records, 256 KiB per before/after file, and 2 MiB of total before/after UTF-8 text. Binary files, terminal controls other than normal tab/newline/CR, and bidirectional display overrides are not supported. A task may write a file that is excluded or exceeds these review limits, but this does not grant authority to merge it.

## Partial failure and crash recovery

The implementation first records a durable application start and saves all original file backups in the private team data directory. Before each source change it syncs an intent containing the path, backup, temporary file, and any new directories. Content is staged in a sibling temporary file and then renamed; deletions use a single unlink. The per-file outcome is persisted after the resulting file has been flushed and checked.

This provides **per-file replacement, not an atomic multi-file transaction**. There is no automatic rollback. If the process or journal fails after application starts, some files may already be changed. The outcome is `unknown`, with confirmed applied paths, potentially affected remaining paths, and the application journal path. Leftover temporary files and newly created directories are evidence, not permission to retry.

Calling apply again on an `unknown` bundle only reports that evidence; it does not replay source writes. Calling it again after a durably completed application reports that it was already applied. For an unknown result, inspect the source, saved backups, and journal, and reconcile manually before creating a new reviewed operation. Do not delete records or steal locks merely to make an apply command run again.

The source lock only coordinates cooperating MaybeCode appliers. It cannot exclude an unrelated editor or process that ignores the lock, and file-copy isolation is not an operating-system sandbox. Source and task files are rechecked immediately before each write, but callers must still keep the selected task copies stopped and avoid concurrent source editing. Files and journals are synced; directory fsync is attempted where supported and is not available on every Windows filesystem.

## Host APIs

`TaskWorkspaceManager.snapshotPatch(taskIds)` returns bounded text changes plus baseline and per-task digests without writing source files. The product module `team-patches.ts` provides:

- `createTeamPatch({ directory, workspaces, taskIds })`
- `readTeamPatch(directory, patchId)` and `renderTeamPatchDiff(bundle)`
- `applyTeamPatch({ directory, workspaces, patchId, confirmDigest })`
- `readTeamPatchApplication(directory, patchId)`

Patch bundles are under the team's `patches/` directory. Application records and backups are private host data, outside task tool roots. They must not be exposed as writable Agent tools. See [MaybeCode teams](maybecode-team.md) for general runtime, budget, and cancellation behavior.

## Interrupted staging cleanup

Stop all team hosts, appliers and editors before calling `cleanupTeamPatchTemporaries`
from `@may/maybecode` with `directory`, `patchId`, the exact `confirmDigest`, and
`confirmHostsStopped: true`. It validates the journal and staging paths before deleting
only recorded `.maybecode-*.tmp` files. Source targets and backups are never removed, and
the application outcome remains unknown until separately reconciled. Cleanup never resumes
or replays source writes.
