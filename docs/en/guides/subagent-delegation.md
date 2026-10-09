# Delegate work to sub-agents

**English** | [简体中文](../../zh-CN/guides/subagent-delegation.md)

Use sub-agents to assign independent work during an ordinary MaybeCode request.
Delegation is enabled by default in terminal UIs, the Web UI, the headless
controller and `MaybeCodeApplication.open()`. The model can call `delegate_tasks`
during an active Run, either following your prompt or choosing to delegate.

This guide assumes a [configured MaybeCode Session](maybecode.md). It explains
request behavior, roles, file responsibilities, budgets and recovery. The
reusable implementation is in `@may/plugin-delegation`; MaybeCode composes that
plugin with the `delegate_tasks` tool from `@may/coordination`.

## Request delegated work

1. Open MaybeCode in the workspace you want the Agents to inspect.
2. Send a prompt with independent assignments, file responsibilities and expected
   evidence. For example: “Delegate source inspection and test inspection to
   separate sub-agents. Each must cite files and report verification gaps.
   Combine their findings in the final answer.”
3. Inspect the task tree, child approvals and usage while the request runs.
   Use `/delegations` to inspect its durable state.
4. Review the final answer and child outcomes. Failed children are included in
   the wakeup data so the main Agent can handle them.

## One request, several Runs, one final answer

A user request is one durable coordination graph. The main Session runs the root
task. When the model calls `delegate_tasks`, the tool records the child tasks, the
current Run ends at the next complete Step boundary with `finishReason: "yielded"`,
and the root task releases its concurrency slot. Each child runs in its own Session
with its own Context, Skills and compaction. Once every child has a terminal
outcome, the main Session continues with a new Run that receives the child reports
as data and produces the answer the user sees.

`controller.submit(...)` returns a `MaybeCodeRun`, which is the request rather than
a single Run. The fragment assumes an opened `MaybeCodeController`, a prepared
Session input and an active host event consumer for approvals:

```ts
const run = await controller.submit({ input });
const result = await run.result;               // 最终汇总结果
const runs = await run.runs();                 // 本请求内每个真实 Run 的身份与结果
console.log(run.requestId, runs.map((item) => `${item.turn}:${item.runId}`));
```

Goal runs and steering runs are requests too, so delegation is available in every
Run the host starts, and the main Session never has two writers.

## Configuration

Merge `apps.maybecode.subagents` into the May configuration used by your host.
The `reviewer.model` below is a configured model profile name; replace it with
one present in your configuration. Its model must support the selected reasoning
effort. These are example limits; defaults are listed after the fragment.

```jsonc
{
  "apps": {
    "maybecode": {
      "subagents": {
        "roles": {
          "worker": {
            "instructions": "Inspect and change only the assigned files.",
            "tools": ["read", "shell", "edit", "write"],
            "delegateTo": ["worker"]
          },
          "reviewer": {
            "model": "deepseek-v4-flash",
            "reasoningEffort": "high",
            "tools": ["read"],
            "delegateTo": []
          }
        },
        "defaultRole": "worker",
        "limits": {
          "maxConcurrent": 2,
          "maxTasks": 24,
          "maxDepth": 3,
          "maxTaskTurns": 6,
          "maxDurationMs": 900000
        },
        "runBudget": { "maxSteps": 24, "maxModelCalls": 24, "maxToolCalls": 48 },
        "maxModelCalls": 128,
        "maxTotalTokens": 200000,
        "reservationTokens": 32768
      }
    }
  }
}
```

`"subagents": false` or `{"enabled": false}` turns delegation off; the tool then
never appears and no request is created. `worker` is registered by default, so
delegation works with no configuration. A role without `model` inherits the main
Session's model and reasoning effort; a role with `model` builds its own model and
`reasoningEffort`. Roles may only create the roles listed in their `delegateTo`.

The main request is depth 1, a delegated child is depth 2 and a grandchild is
depth 3; `maxDepth` refuses anything deeper, and `maxTasks` bounds the tasks of one
request including the main task.

Default graph limits are 2 concurrent tasks, 24 total tasks, depth 3, 6 turns per
task and 15 minutes per request. Task inputs are limited to 32,768 UTF-8 bytes
and outputs to 65,536 bytes. A child Run also has a five-minute default deadline.
`maxTotalTokens` is omitted by default; add it to enforce a request token allowance.

## Prompt, briefs and file ownership

Every child brief must be standalone: goal, constraints, expected evidence and
report format. A child only receives that brief, never the parent's history, and
its report is data rather than instructions. The `files` list of a child declares
the workspace-relative files it may modify:

- the child may read any file in the workspace;
- `write` and `edit` refuse paths outside the declared `files`;
- an existing file must be read by that child first, and a file whose content
  changed after the read is refused as a conflict;
- the `shell` tool has none of these limits, which is why briefs state file
  ownership explicitly.

File locks and version checks are shared by the main task and all children of one
workspace and cover this application's file tools. Changes made by a process
outside the application are detected on the next operation, not prevented.

## Budget

A child Run gets 24 steps, 24 model calls and 48 tool calls by default; a child
keeps the smaller value between its role `runBudget` and the
`apps.maybecode.subagents.runBudget`. The main Run gets 32 steps and a caller
changes that ceiling only with the `maxSteps` option, in either direction. One
request shares 128 model calls across the main Run, every child Run, the summary
calls made inside a Run and provider-native compaction calls. Every real
provider attempt reserves capacity before it is sent, so concurrent calls, extra
Steps and automatic provider retries all draw on the same ceiling. Each attempt
gets its own ledger entry: the retry wrapper announces the next attempt with a
`retrying` event, the budget records the failed attempt as unknown and reserves
the next attempt before it is sent. An attempt the ledger refuses is never sent,
so the request ends with the provider error that triggered the retry: that error
keeps the provider's name, message and code, the call identity of the failed
attempt and the reason the ledger blocked. Without an active request ledger the
retry policy of `apps.maybecode.retry` is unchanged.

The token ceiling is checked against a per-call reservation: insufficient capacity
fails before the request is sent. Calls that were already sent settle with their
real usage, so several concurrent calls can exceed the ceiling by the sum of their
overruns; a blocked ledger stops the request before the next model call. A provider
that reports no usage marks that call unknown and has the same effect, so usage can
never be skipped silently; the automatic retry of that same request is then refused
before it is sent, because the failed attempt is already unknown. After an unclean
exit, pending calls become unknown when the ledger is reopened. Goal and steering
Runs are requests too, so their calls are counted in the same ledger.

Native compaction that reports usage settles with it. A compactor that reports
nothing is charged its reservation and marked as an estimate, and the request
report then shows the token total as incomplete. Token totals combine provider
usage and estimates; they are not a ceiling on what a provider may charge.

## Approvals, cancellation and recovery

Child tool requests use the same permission policy as the main Session, so a
denial stays a denial and no session grant is shared. Approvals are routed to the
task that raised them, and TUI, Web UI and headless callers answer through
`resolveApproval` as usual. A new user message, `cancel` and `close` stop the
request, its children and their descendants. Session and model changes require
the running request to finish or be cancelled first.

An explicitly cancelled request returns `RunCancelledError`. Interrupted model
usage stays unknown in the ledger and the request report keeps `usageComplete`
false.

A process that ends mid-request leaves a durable record. The next start reports
the request as interrupted, marks unfinished tasks as recovery-required, and never
replays a tool, a model call or a child Run. After checking external effects,
recovery findings can also close queued tasks and parents waiting for children
while the coordination runtime remains stopped:

```text
/delegations
/delegations tools <task-id>
/delegations resolve <task-id> <failed|cancelled> <verified finding>
```

Stale writer locks are never taken over automatically; use the coordination lock
recovery command with the exact lock contents after confirming the owner stopped.
The recent-request index contains up to 16 requests. Durable request journals and
budgets remain on disk after completion.

## Surfaces

- TUI and retained TUI print the request lifecycle, task tree with parent ids,
  statuses, child tool output prefixed with the task id, and child approvals.
- The Web UI adds a 子 Agent panel with the task tree, per-request usage and the
  commands above; `/delegations` also works in its console.
- Headless callers receive `delegation.started`, `delegation.updated`,
  `delegation.finished` and `delegation.event` events, plus
  `listDelegationRequests()`, `getDelegationState()`, `delegationToolRecords()`
  and `resolveDelegationRecovery()`.
- `/instructions` shows the same collaboration section that the model receives,
  including the currently authorized roles and limits while the delegation tool
  is available in this Run.
