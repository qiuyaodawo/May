# Team inspection and explicit recovery

**English** | [简体中文](../../zh-CN/guides/maybecode-team-recovery.md)

Use host inspection and verified evidence to resolve interrupted team work.
Reconciliation records a finding; retry authorizes a new attempt; `resume`
starts eligible execution. Each operation has its own command.

This guide applies to version 2 teams and assumes you know the team ID and its
original data root. Stop surviving task/check processes before recording their
outcomes. Repository users prefix commands with `pnpm`. Legacy v1 teams retain
their original `resume`, `status` and `cancel` operations.

## Inspect first

```powershell
maybecode team status <id> --data-directory <data-root>
```

Status reads durable journals without taking over a running team. It shows task
failures, unsuccessful dependencies, attempts and Session identities, unsettled
tool evidence, budget call IDs and unknown check command IDs. A pending check may
still be running. The last acceptance projection is explicitly labeled as possibly
stale; `team verify` checks current workspace fingerprints. Monitoring reads
separate journals; recovery requires exclusive ownership and full evidence inspection.

Recovery controls acquire the same exclusive resource and coordinator ownership
as a run. An active owner or crash-left lock blocks them. Never delete a lock
before verifying its process has stopped, and never erase journals to force a
retry. Control commands do not load model credentials or construct a provider.

## Reconcile one known finding

1. Independently verify the affected task, provider receipt or check outcome.
2. Create a UTF-8 JSON resolution file outside the task copies, using exactly
   one of the formats below. Replace example identities, usage and findings
   with the evidence for this team.

```json
{
  "format": 1,
  "kind": "budget",
  "callId": "the-exact-call-id-from-status",
  "usage": { "inputTokens": 100, "outputTokens": 20, "totalTokens": 120 },
  "finding": "Verified against the provider usage record for this exact request."
}
```

The numbers above illustrate the fields. Supply real usage;
zero requires evidence of zero usage. Reconciliation does not refund actual usage,
raise limits, retry a request or release an old model result to tools.

For a task whose effects have been inspected:

```json
{
  "format": 1,
  "kind": "task",
  "taskId": "implementation",
  "outcome": "failed",
  "finding": "Inspected the recorded tool effects and stopped surviving work; retain the partial edits for review."
}
```

For an interrupted deterministic check:

```json
{
  "format": 1,
  "kind": "check",
  "commandId": "the-exact-check-command-id-from-status",
  "outcome": "cancelled",
  "finding": "Verified that the test process and its descendants stopped; inspected resulting file changes."
}
```

Task/check outcomes can be `failed` or `cancelled`, never manufactured success.
A task finding acknowledges effects at coordination level; it does not rewrite
old Session history. Budget and check records remain separate and may also need
their own reconciliation. A passing verification record does not by itself close
an unknown Session tool checkpoint.

3. Preview the resolution, inspect the finding and digest, then confirm that
   exact preview:

```powershell
maybecode team reconcile <id> --resolution resolution.json
maybecode team reconcile <id> --resolution resolution.json --confirm <digest>
```

The digest binds the finding and current task, budget and verification evidence.
Changed state or a changed file requires a new preview. Confirmation records the
finding only; it does not run Agents, tools or tests. The host must actually verify
the finding; JSON records the host's already-verified conclusion.

## Review the impact before retrying

1. Resolve unknown task, model-usage and check outcomes using the procedure above.
2. Preview the selected failed or cancelled task's retry and inspect its impact.
3. Confirm the exact digest, then call `resume` as a separate execution command:

```powershell
maybecode team retry <id> --task implementation --finding "Verified failure; explicitly authorize a fresh attempt."
maybecode team retry <id> --task implementation --finding "Verified failure; explicitly authorize a fresh attempt." --confirm <digest>
maybecode team resume <id>
```

The preview names affected dependants and owned children. Confirmation queues
only the selected task with a new Session/dispatch; `resume` is separate. The
durable retry receipt is checked again at dispatch. Old histories, usage and
workspace edits remain; a retry is not a rollback or clean checkout.

Unknown budget/check effects block retries. Runtime checks additionally reject
unknown task effects, consumed results, incompatible pending messages, active
descendants, stopped/expired teams and exhausted lifetime limits. Failed
dependants are **not** automatically retried after their upstream task succeeds;
preview and authorize each separately. Completed tasks are not retry candidates.
Cancellation and deadlines do not silently reset; stopped teams may require a new
explicit team when more work is needed.

## Cancellation and verification

`team cancel <id>` records a request consumed by the run or host verification
owner. An interrupted command check becomes unknown, not safely rolled back.
Inspect surviving descendants before reconciliation. `team verify <id>` invokes
configured checks explicitly and cannot clear cancellation or replay unknown
commands. See [acceptance](maybecode-team-verification.md) and
[patch application](maybecode-team-coding.md) for their distinct outcome records.

All commands support `--data-directory`; use the original team root. Patch
application failures retain backups and per-file evidence; no control here
automatically rolls back or resumes an unknown source application.
