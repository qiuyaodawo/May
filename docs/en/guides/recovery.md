# Recover an interrupted Session

**English** | [简体中文](../../zh-CN/guides/recovery.md)

Use this procedure after a process interruption or persistence failure. It
requires the same Session store and id, plus access to any external systems
affected by unfinished tools. Recovery may require a human to verify whether
an operation completed before accepting new work.

## 1. Reopen the Session

Close the interrupted host and open the saved Session with `resume: true`.
The host must supply its current model, tools, instructions, and permission
policy. [Configure Session storage](custom-storage.md) explains storage setup.

`Session.resume()` records unfinished Runs as `run.interrupted` and preserves
completed outcomes. It marks calls as follows:

| Saved evidence | Recovery result |
| --- | --- |
| No tool-start checkpoint | `TOOL_NOT_EXECUTED` |
| Tool started with no saved outcome | `TOOL_OUTCOME_UNKNOWN` |
| Legacy history without checkpoint version metadata | All unfinished calls are unknown |

Recovery reconstructs conversation state without executing tools or calling a
model. Unresolved unknown outcomes block `submit()` and `continue()` with
`SESSION_RECOVERY_REQUIRED`.

## 2. Inspect pending recoveries

In either MaybeCode terminal UI, execute `/recovery`. A custom host calls
`listRecoveries()` on its controller. Each item includes the original tool
input and an `id` containing its stable idempotency key.

## 3. Verify and record each external result

Inspect the affected service, file, or process. Use the original idempotency key
when the service offers result lookup. Record a finding only after obtaining
evidence about the operation's result.

The following command illustrates the format; replace the recovery id and
finding with the values you verified:

```text
/recovery resolve run_id:1:call_id Checked the destination: the record exists; do not create it again.
```

Custom hosts call `resolveRecovery(id, verifiedFinding)`. Session stores the
finding and adds it to model Context. Resolving an item changes recovery state
without executing the tool.

## 4. Continue after all unknown results are resolved

Inspect the recovery list again. Once it has no unresolved unknown outcomes,
submit a new instruction. Reopening preserves unresolved items and records each
interruption once.

## Checkpoint ordering

Session installs Core's awaited `RunOptions.checkpoint` barrier. Run starts,
complete model responses, tool starts and individual tool outcomes are stored
before dependent work can proceed. A sequential batch cannot start its next
tool until the previous outcome is durable. These barriers apply to every tool,
including tools allowed without approval. A tool start precedes permission
evaluation: interrupted approval waits are conservatively treated as unknown.

## Persistence failures and storage limits

Persistence failures make the live Session unusable; reopen it before further work.
Core reports failed barriers as `RUN_CHECKPOINT_FAILED`, aborts parallel peers
and waits for started executions to settle. It does not invent successful or
cancelled outcomes for uncertain effects or automatically retry failed writes.
FileSessionStore syncs records before acknowledging writes, and repairs an
unterminated final record on read. Corrupt newline-terminated records fail closed.
Only one writer per session is supported. These guarantees cover process crashes
and acknowledged store writes, not distributed transactions or exactly-once
effects in arbitrary external systems. Remote tools should implement idempotency
or outcome lookup; recovery findings supply the explicit host reconciliation path.
