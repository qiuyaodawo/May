# Configurable MaybeCode teams

[简体中文](../../zh-CN/guides/maybecode-team-plan.md)

MaybeCode uses one coordination runtime for preset and custom task graphs. A plan selects roles, configured model profiles, tools, dependencies, checks, and bounded coordination limits. It is not a new agent implementation and cannot grant authority beyond the host-selected mode.

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

```powershell
maybecode team run "Review the module" --plan C:\work\review-plan.json --workspace C:\work\example
```

`model` names an existing profile in the May config, not an inline provider or credential. An omitted role model uses the team's selected default. `instructions` add role-specific guidance; they do not replace the host's safety rules. Task `input` is literal text, not a template language or shell command. `resultTaskId` selects the task whose answer is displayed as the final result; it does not exempt other tasks from completion or verification.

Omitted role tools default to `read`, `list_files`, `publish_artifact`, `read_artifact`, `submit_report`, and `run_check`. An explicit array is an allowlist, including an empty array. `delegateTo` defaults to `[]` and accepts only defined roles. `messaging` defaults to `false`; enabling it does not grant delegation. `write` and `edit` require the explicit CLI `--mode coding`; a plan cannot contain `mode` or enable coding itself. Command checks independently require the host's `--allow-checks` authorization, even in coding mode. File checks do not execute a process.

Role `runBudget` and `limits.runBudget` are per-Run ceilings and cannot loosen stricter host budgets. Shared physical-call/token limits remain team-level CLI controls; a role cannot allocate itself a separate unmetered model. See [team verification](maybecode-team-verification.md) for reports and check types.

## Validation and persistence

- JSON is limited to 1 MiB, 16 roles, and 128 initial tasks. Task inputs are limited to 65,536 UTF-8 bytes and role instructions to 16,384 bytes. Preset user prompts retain the team's 32,768-byte limit.
- Unknown fields/tools, duplicate IDs/dependencies, missing roles/dependencies/check task references, cycles, invalid Run budgets, and exceeded quotas are rejected before dispatch. IDs use 1–128 ASCII letters, digits, dots, underscores, or hyphens; reserved object keys are rejected.
- Plan coordination ceilings are bounded: concurrency 8, total tasks 128, deadline 24 hours, output 256 KiB, depth 8, turns 64, messages 4,096, attempts 8, and graph revisions 128. These are parser ceilings, not default allocations. The presets retain the smaller [team defaults](maybecode-team.md).
- The normalized plan is saved with the team. Resume uses that saved plan and pinned model configuration, not a changed or missing external plan file. Editing a plan file changes future runs only.

Plan files are trusted host configuration: review their model routing, tool grants, delegation edges, and exact check commands before starting. Source files, model output, peer messages, and report text remain untrusted data and cannot rewrite the plan.
