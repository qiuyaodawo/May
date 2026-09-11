# MaybeCode teams

[简体中文](../../zh-CN/guides/maybecode-team.md)

MaybeCode's noninteractive `team` command runs a bounded, persistent multi-agent investigation from the terminal. It uses the same May config and named model profiles as normal MaybeCode. The current product preset is **read-only**: two independent workers inspect the requested task, then a supervisor combines their evidence and can delegate small follow-up investigations.

## Run a team

From this repository:

```powershell
pnpm maybecode team run "Review this module for correctness risks; cite files and propose a minimal fix without changing files." --workspace C:\work\example --max-concurrent 2 --max-model-calls 16 --max-total-tokens 262144
```

With an installed current build, replace `pnpm maybecode` with `maybecode`. Use `--config <path>` and `--model <profile>` to choose another configured connection. Credentials are resolved through existing provider configuration; they are not printed or copied into the team manifest.

The terminal prints the team ID, per-task status and tool names, the supervisor's final answer, shared usage totals, and immutable output artifact references. A successful team exits `0`; failed, cancelled, waiting, or recovery-blocked work exits `1`. Invalid CLI syntax exits `2`.

Default bounds are two concurrent tasks, eight total tasks, two delegation levels, four turns per task, a ten-minute team deadline, 32 physical model calls, and 524,288 shared tokens. A Run is also bounded to ten model steps/calls, 24 tool calls, and three minutes; existing stricter configured Run budgets still apply. `--max-concurrent` accepts 1–8. The token limit must allow at least one 32,768-token model reservation. Actual usage replaces the reservation after each durable response; it is not a prepaid guarantee of provider spend. Missing or ambiguous provider usage blocks further model calls pending verified host reconciliation. Team mode disables transparent provider retries and native compaction to avoid unmetered calls.

## Storage, status, resume, and cancellation

By default, records live under `~/.may/maybecode/teams/<id>/`. `--data-directory <path>` changes the MaybeCode data root; use the same flag for subsequent commands. The data directory must be outside the source workspace.

```powershell
maybecode team status <id>
maybecode team resume <id>
maybecode team cancel <id>
```

`status` reads a non-authoritative progress projection without taking over the active runtime. `cancel` writes a cancellation request; the running owner consumes it and cancels the team. If no process owns the team, `resume` consumes the request and records cancellation without dispatching new work. Ctrl+C also cancels the current owner. Cancellation cannot undo an already completed provider request or tool effect.

`resume` uses the original workspace, model profile, routing/options fingerprint, and saved resource limits. It does not repeat completed inputs. Configuration drift, unknown tool effects, and unknown model usage fail closed. The CLI does not invent reconciliation findings or steal stale writer locks; those require host inspection. The data directory contains isolated workspaces, Sessions, coordination snapshots, shared budget records, and immutable UTF-8 artifacts. Treat these files as private: they contain task prompts and selected source excerpts, even though credential files are filtered out of workspace copies.

## Authority and isolation

- Every task receives its own copy of one filtered baseline. Later tasks see the same initial files, not concurrent changes to the source checkout. Outputs are not automatically merged.
- Read and bounded directory listing operate inside that task's copy. Shell, source editing, MCP, and inherited approval grants are unavailable.
- Only the supervisor may delegate, and only to workers. The product explicitly allows task-addressed messages and reads of artifacts published within this team; unknown tools are denied.
- Final answers are automatically published as immutable artifacts. Agents may also publish text artifacts and share exact references.
- The preset does not promise a process sandbox. Exclusion rules reduce accidental secret inclusion; they do not prove every allowed source file is free of sensitive data. Select a workspace that is safe to send to the configured provider.

This CLI preset is intentionally narrower than the reusable [coordination APIs](coordination.md). Handoff, host-managed retries, graph editing, and remote workers are composed by host applications rather than unrestricted terminal model tools.
