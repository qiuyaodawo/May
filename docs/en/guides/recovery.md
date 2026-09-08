# Crash recovery

[简体中文](../../zh-CN/guides/recovery.md)

Session installs Core's awaited `RunOptions.checkpoint` barrier. Run starts,
complete model responses, tool starts and individual tool outcomes are stored
before dependent work can proceed. A sequential batch cannot start its next
tool until the previous outcome is durable. These barriers apply to every tool,
including tools allowed without approval. A tool start precedes permission
evaluation: interrupted approval waits are conservatively treated as unknown.

On `Session.resume()`, unfinished runs receive an atomic `run.interrupted`
record. Completed outcomes are retained. Calls without a tool-start checkpoint
are closed with `TOOL_NOT_EXECUTED`; started calls without an outcome are closed
with `TOOL_OUTCOME_UNKNOWN`. Legacy histories without checkpoint version metadata
treat all unfinished calls as unknown. Recovery never replays tools or calls a model.

Unknown outcomes block both submit and continue with `SESSION_RECOVERY_REQUIRED`.
`listRecoveries()` returns the original input and stable idempotency key as `id`.
The host must inspect the external system, then call
`resolveRecovery(id, verifiedFinding)`. The finding is durably recorded and added
to model context. Resolving an item never executes it. Reopening preserves
unresolved items and does not duplicate interruption records.

In either MaybeCode UI, use `/recovery` to inspect pending items, then:

```text
/recovery resolve run_id:1:call_id Checked the destination: the record exists; do not create it again.
```

After every unknown outcome is resolved, submit a new instruction to continue.
The controller exposes the same methods for custom UIs.

Persistence failures poison the live Session; reopen it before further work.
Core reports failed barriers as `RUN_CHECKPOINT_FAILED`, aborts parallel peers
and waits for started executions to settle. It does not invent successful or
cancelled outcomes for uncertain effects or automatically retry failed writes.
FileSessionStore syncs records before acknowledging writes, and repairs an
unterminated final record on read. Corrupt newline-terminated records fail closed.
Only one writer per session is supported. These guarantees cover process crashes
and acknowledged store writes, not distributed transactions or exactly-once
effects in arbitrary external systems. Remote tools should implement idempotency
or outcome lookup; recovery findings supply the explicit host reconciliation path.
