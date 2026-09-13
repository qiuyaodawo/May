# Team reports and acceptance

[简体中文](../../zh-CN/guides/maybecode-team-verification.md)

MaybeCode records two independent outcomes: the coordination task may be `completed`, while its acceptance is `passed`, `failed`, or `unverified`. A model cannot set acceptance by saying that its work is verified.

## Structured reports

The `submit_report` tool stores a summary and a bounded list of findings or proposals:

```json
{
  "summary": "The average implementation has a denominator error.",
  "claims": [
    {
      "kind": "finding",
      "text": "The divisor includes an extra element.",
      "evidence": [{ "path": "average.mjs", "startLine": 4, "endLine": 4, "quote": "values.length + 1" }]
    }
  ]
}
```

The host stamps the task, dispatch, and turn identity. It validates relative paths, file existence, line ranges, and optional quoted text, and records file hashes. These checks establish that the cited bytes exist; they do **not** establish the logical correctness or completeness of the claim. Reports are immutable and tool-call identities are idempotent. Later reports retain earlier history.

Reports are limited to 64 KiB, 64 claims, and 16 evidence references per claim. Absolute paths, traversal, symbolic links, and unknown fields are rejected. Evidence quotes normalize CRLF to LF.

## Host-defined checks

Use the `checks` field in a [team plan](maybecode-team-plan.md). Each globally unique check ID belongs to one declared task:

```json
[
  { "id": "divisor", "taskId": "implementation", "type": "file-contains", "path": "average.mjs", "text": "total / values.length" },
  { "id": "tests", "taskId": "implementation", "type": "command", "command": "node", "args": ["--test", "average.test.mjs"], "timeoutMs": 30000, "maxOutputBytes": 65536 }
]
```

Available check types:

- `file-contains`: exact UTF-8 substring predicate.
- `file-sha256`: exact file SHA-256, supplied as 64 lowercase hexadecimal characters.
- `command`: an exact executable and argument list supplied by the host configuration. Exit code zero is a passing check, not proof that the configured test is meaningful.

The model can call `run_check` with an ID only. It cannot replace the command, arguments, timeout, output limit, or working directory. Command checks additionally require explicit `--allow-checks` authorization. This is true even for a read-only team: read-only file tools do not constrain what an authorized process can do.

Commands use no shell, a fixed task workspace, a small environment allowlist without inherited API keys or `NODE_OPTIONS`, hidden Windows processes, and bounded output/time. Defaults are 30 seconds and 64 KiB; maximums are 120 seconds and 1 MiB.

**This is not an OS sandbox.** Tests can execute arbitrary code, read files outside the workspace, find credentials in other files, use the network, write outside the copy, or launch descendants. Terminating the direct child does not prove its descendants have stopped. Authorize only reviewed commands and use an external sandbox for untrusted code. Do not put credentials in arguments or allowlisted environment values. Output and reports are persisted as private local task data.

## Freshness and acceptance

A report and each check are bound to a fingerprint of **all** file paths, directory names, and file contents in the task copy. Inspection is bounded to 10,000 entries and 64 MiB and rejects symbolic links. A check records fingerprints before and after execution. If the workspace changes during or after the check, the result is stale and cannot grant acceptance. Test-generated files also invalidate the original fingerprint; no changed file is silently ignored.

Acceptance is `passed` only when a current structured report exists and all configured checks for that task pass for those exact bytes. Invalid current evidence or a failed check produces `failed`. No checks, missing results, stale results, interrupted work, or missing current reports produces `unverified`. A retry must use its current dispatch and turn, not an earlier report. Acceptance covers configured checks only; it is not a general claim that the program is correct.

Use `team verify <id>` for explicit host verification and `team status <id>` to inspect execution separately from acceptance. File predicates may be evaluated when work completes; command checks are not silently launched again by status, recovery, or acceptance inspection.

Static downstream tasks receive a bounded host verification record alongside each
dependency answer. It identifies checks on that dependency's private workspace,
not the downstream task's baseline or the shared source. Peer prose remains
untrusted, and the host record does not certify all of its claims.

## Interrupted checks

The local exclusive-writer journal fsyncs a `pending` intent **before** a check starts. Timeout, cancellation, output overflow, uncertain termination, or a recovered pending record produces `unknown`. The same command identity never launches another process, and a pending/unknown check blocks subsequent checks for that task.

Inspect the effects and stop any surviving processes before recovery. Host reconciliation records evidence and can mark an unknown check only `failed` or `cancelled`; it cannot invent a green result and never runs a command. A later explicitly authorized verification needs a new command identity. Crash-left writer locks require host investigation; they are not stolen automatically. A successful check written to the verification ledger does not automatically reconcile a separate interrupted Session tool checkpoint.

The store keeps reports and all check command identities in `verification.jsonl`, with a 16 MiB journal limit, at most 256 reports, and at most 512 checks. Read-only status inspection does not acquire the writer lock. An incomplete final line is ignored by readers and repaired by a subsequent exclusive writer; committed malformed records are rejected.

## Native command checks

Command checks use `shell: false`: on Windows use a native executable such as `node.exe`
with the package manager's JavaScript entry point and argument array. `.cmd` / `.bat` files
are not supported, and failure to start a process is recorded as `failed`, not an unknown
executed action. Pending processes with uncertain effects still require reconciliation.
The 512-check quota counts distinct command identities, not pending/result journal lines;
reaching it rejects a new check without making existing status unreadable.
