# Configure a MaybeCode team plan

**English** | [简体中文](../../zh-CN/guides/maybecode-team-plan.md)

Use a preset for its predefined task graph, or save a JSON plan to choose roles,
model profiles, tools, dependencies, checks and limits. Both use the same
coordination runtime. A plan grants capabilities within the mode selected by
the host.

This guide assumes you can [run a MaybeCode team](maybecode-team.md). Repository
users prefix the commands below with `pnpm`. Review the plan's tool permissions
and exact check commands before starting a run.

## Presets

```powershell
maybecode team run "Inspect this module" --preset supervisor --workspace C:\work\example
maybecode team run "Review the proposed approach in stages" --preset pipeline --workspace C:\work\example
maybecode team run "Compare independent findings" --preset parallel --workspace C:\work\example
```

| Preset | Initial graph | Dynamic delegation |
| --- | --- | --- |
| `supervisor` (default) | `analysis` and `review` run independently, then `summary` | Supervisor may delegate to `worker` |
| `pipeline` | `analysis` → `review` → `summary`; summary receives both reports | Disabled |
| `parallel` | `analysis` and `review` run independently, then `summary` | Disabled |

Dependencies transfer explicit reports, **not workspace changes**. Every task starts from its own copy of the same filtered baseline, including pipeline stages. A reviewer must not assume a preceding task's edits exist in its copy. The coding workflow exports reviewable changes separately; plans never automatically merge them.

## Custom JSON plan

1. Add a `review-model` profile to your May configuration, or replace that name
   below with an existing profile.
2. Choose the file predicate that represents your requirement. This example
   expects `README.md` in the source workspace to contain the exact text `Contract`.
3. Save the following UTF-8 JSON as `C:\work\review-plan.json`, outside the source
   workspace. Its `reader` task inspects the module, and `summarizer` consumes
   that task's report:

```json
{
  "format": 1,
  "name": "module-review",
  "roles": {
    "reader": {
      "model": "review-model",
      "instructions": "Inspect source and cite concrete evidence.",
      "tools": ["read", "list_files", "submit_report", "run_check"],
      "runBudget": { "maxModelCalls": 4, "maxToolCalls": 12 }
    },
    "summarizer": {
      "tools": ["read", "read_artifact", "submit_report"],
      "instructions": "Separate verified findings from unverified claims."
    }
  },
  "tasks": [
    { "id": "inspect", "agent": "reader", "input": "Inspect README.md and explain the module contract." },
    { "id": "final", "agent": "summarizer", "input": "Summarize the supplied inspection report.", "dependsOn": ["inspect"] }
  ],
  "resultTaskId": "final",
  "limits": { "maxConcurrent": 2, "maxTasks": 4, "maxDurationMs": 300000 },
  "checks": [
    { "id": "contract-present", "taskId": "inspect", "type": "file-contains", "path": "README.md", "text": "Contract" }
  ]
}
```

4. Start the team with the saved plan:

```powershell
maybecode team run "Review the module" --plan C:\work\review-plan.json --workspace C:\work\example
```

5. Inspect the `final` answer and each task's execution and acceptance status.
   For a task with configured checks, passing acceptance requires a current
   structured report and passing checks against its current workspace.

`model` names an existing profile in the May config, not an inline provider or credential. An omitted role model uses the team's selected default. `instructions` add role-specific guidance; they do not replace the host's safety rules. Task `input` is literal text, not a template language or shell command. `resultTaskId` selects the task whose answer is displayed as the final result; it does not exempt other tasks from completion or verification.

Omitted role tools default to `read`, `list_files`, `publish_artifact`, `read_artifact`, `submit_report`, and `run_check`. An explicit array is an allowlist, including an empty array. `delegateTo` defaults to `[]` and accepts only defined roles. `messaging` defaults to `false`; enabling it does not grant delegation. `write` and `edit` require the explicit CLI `--mode coding`; a plan cannot contain `mode` or enable coding itself. Command checks independently require the host's `--allow-checks` authorization, even in coding mode. File checks do not execute a process.

Role `runBudget` and `limits.runBudget` are per-Run ceilings and cannot loosen stricter host budgets. Shared physical-call/token limits remain team-level CLI controls; a role cannot allocate itself a separate unmetered model. See [team verification](maybecode-team-verification.md) for reports and check types.

## Validation and persistence

- JSON is limited to 1 MiB, 16 roles, and 128 initial tasks. Task inputs are limited to 65,536 UTF-8 bytes and role instructions to 16,384 bytes. Preset user prompts retain the team's 32,768-byte limit.
- Unknown fields/tools, duplicate IDs/dependencies, missing roles/dependencies/check task references, cycles, invalid Run budgets, and exceeded quotas are rejected before dispatch. IDs use 1–128 ASCII letters, digits, dots, underscores, or hyphens; reserved object keys are rejected.
- Plan coordination ceilings are bounded: concurrency 8, total tasks 128, deadline 24 hours, output 256 KiB, depth 8, turns 64, messages 4,096, attempts 8, and graph revisions 128. The parser validates plans against these ceilings. Presets use the [team defaults](maybecode-team.md).
- The normalized plan is saved with the team. Resume uses that saved plan and pinned model configuration, not a changed or missing external plan file. Editing a plan file changes future runs only.

Plan files are trusted host configuration: review their model routing, tool grants, delegation edges, and exact check commands before starting. Source files, model output, peer messages, and report text remain untrusted data and cannot rewrite the plan.
