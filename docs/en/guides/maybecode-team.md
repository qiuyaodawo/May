# MaybeCode teams

[简体中文](../../zh-CN/guides/maybecode-team.md)

MaybeCode's noninteractive `team` command runs bounded, persistent multi-agent work from the terminal. It reuses the May config and named model profiles. New v2 teams support configurable plans, structured evidence and acceptance, explicit recovery controls, and reviewed coding patches. The default remains **read-only**: two independent workers investigate, then a supervisor summarizes and may delegate small follow-ups.

## Run and configure

From this repository:

```powershell
pnpm maybecode team run "Review this module for correctness risks; cite files and propose a minimal fix without changing files." --workspace C:\work\example --max-concurrent 2 --max-model-calls 16 --max-total-tokens 262144
```

With an installed current build, replace `pnpm maybecode` with `maybecode`. Use `--config <path>` and `--model <profile>` to choose another configured connection. Credentials are resolved through existing provider configuration; they are not printed or copied into the team manifest.

`--preset supervisor|pipeline|parallel` selects orchestration, or `--plan <json-file>` supplies roles, model profiles, tool allowlists, dependencies, budgets, and exact checks. These options are mutually exclusive. Plans are validated and saved with the team; resume does not reload an external plan file. See [configurable plans](maybecode-team-plan.md).

Preset defaults are two concurrent tasks, eight total tasks, two delegation levels, four turns per task, a ten-minute team deadline, 32 physical model calls, and 524,288 shared tokens. Each Run is also bounded to ten model steps/calls, 24 tool calls, and three minutes; stricter configured budgets still apply. Custom plans can select other bounded coordination limits and tighten per-role Run budgets. `--max-concurrent` accepts 1–8; an explicit CLI value overrides the plan's concurrency setting.

The token limit must allow at least one 32,768-token model reservation. Actual usage replaces the reservation after each durable response; this is not a prepaid guarantee of provider spend. Missing or ambiguous provider usage blocks new model calls pending verified reconciliation. Team mode disables transparent provider retries and native compaction to avoid unmetered calls.

## Execution is not acceptance

The terminal reports task statuses, tool names, the selected result task's answer, shared usage, immutable artifacts, and a separate acceptance status:

- `completed` means execution reached a durable result, not that the answer is correct.
- `passed` acceptance means the required current structured reports and configured checks passed for the recorded workspace bytes. It does not prove every natural-language claim.
- Missing checks/reports, changed workspaces, or unknown check results leave acceptance `unverified`; failed checks or invalid current evidence can make it `failed`.

Without configured checks, completed execution exits `0` but remains unverified. With configured checks, exit `0` also requires passing acceptance. Incomplete execution or required acceptance not passing exits `1`; invalid CLI syntax exits `2`. `team verify <id>` explicitly runs configured checks and refreshes acceptance. Read-only file checks may also run when a task completes; command checks are never replayed by status or recovery. See [reports and acceptance](maybecode-team-verification.md).

## Storage and lifecycle

Records default to `~/.may/maybecode/teams/<id>/`. `--data-directory <path>` changes the MaybeCode data root; use the same flag for subsequent commands. The data directory must be outside the source workspace.

```powershell
maybecode team status <id>
maybecode team resume <id>
maybecode team cancel <id>
maybecode team verify <id>
```

`status` inspects execution, failed dependencies, unresolved tool evidence, shared usage, and verification records without taking over an active owner. Its cross-journal view and last acceptance projection may be stale. `verify` takes ownership and evaluates configured checks; it is not another model run.

`cancel` writes a request consumed by the running owner or by the next `resume`. Ctrl+C also cancels the active team. Cancellation cannot undo an already completed provider request or tool effect, and killing a direct check process does not prove its descendants stopped.

`resume` uses the saved plan, authority mode, model bindings/fingerprints, and resource limits. It does not repeat completed inputs. Configuration drift, unknown effects, unknown usage, and stale writer locks fail closed. Records include private prompts, source excerpts, workspaces, Sessions, budget journals, verification evidence, and artifacts; secret-file filtering does not make these records public data.

## Explicit recovery

Recovery commands separate preview, confirmation, and execution:

```powershell
maybecode team retry <id> --task <task-id> --finding "Verified reason for another attempt"
maybecode team retry <id> --task <task-id> --finding "Verified reason for another attempt" --confirm <digest>
maybecode team reconcile <id> --resolution C:\work\resolution.json
maybecode team reconcile <id> --resolution C:\work\resolution.json --confirm <digest>
maybecode team resume <id>
```

The first invocation displays its scope and a digest. Confirmation must match that preview. Retry queues one new Session/attempt; it does not start an Agent, reset quotas, roll back effects, or automatically retry dependants. Reconciliation records verified evidence for one task, model-usage record, or check; task/check reconciliation cannot manufacture `passed` or a successful answer. Execution resumes only through the separate `resume` command. See [recovery controls](maybecode-team-recovery.md) for formats and safety constraints.

## Controlled coding and permissions

`--mode coding` permits explicitly listed `write`/`edit` tools in private task copies. The plan cannot enable that mode itself. `--allow-checks` independently authorizes exact configured executable/argument pairs; models choose check IDs, not arbitrary commands. **Authorized processes are not OS-sandboxed**, even when the team uses read-only file tools. They can read or write outside the copy, use the network, and launch descendants. Authorize only reviewed commands/code or use an external sandbox. No automatic dependency installation is performed.

Each task receives the same filtered baseline. Dependencies transfer reports, not edits: a pipeline reviewer does not inherit the preceding task's modified files. Task edits never merge automatically. After execution, export and review selected completed tasks:

```powershell
maybecode team diff <id> --tasks analysis,review
maybecode team apply <id> --patch <patch-id> --confirm <digest>
```

Application checks the reviewed patch, source baseline, task snapshots, and conflicts before source writes. Configured acceptance for selected patch tasks must be current and passing. A selected task with no configured checks is explicitly reported as unverified, human-reviewed work; another task's green checks do not verify it. Application is a host-only action, not a model tool or a Git commit. See [controlled coding](maybecode-team-coding.md) for conflict handling, backups, and partial-failure recovery.

Tool permissions, delegation targets, and messaging are role-scoped. The default supervisor delegates only to workers; messaging defaults off unless enabled in the plan. MCP, arbitrary Shell tools, recovery controls, and source application are never exposed to team models. File-copy isolation and exclusion rules reduce accidental sharing but are not security sandboxes or a guarantee that source files contain no secrets.

## Existing teams and remaining scope

Existing v1 teams retain their original read-only `resume`, `status`, and `cancel` behavior. They are not silently upgraded to v2 permissions or verification. Start a new team to use the new controls.

The terminal composition is narrower than the reusable [coordination APIs](coordination.md): unrestricted graph mutation, handoff, and remote worker hosting remain host-level integrations, not model-granted capabilities. This release does not add distributed coordinator ownership or a global cross-host quota service.
