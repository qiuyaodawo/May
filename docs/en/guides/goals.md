# Run work toward a goal

**English** | [简体中文](../../zh-CN/guides/goals.md)

`@may/goal` provides an external `GoalController`, model tools, context composition,
usage accounting and a storage interface. Agent packages remain independent of it.
MaybeCode connects the component to each Session and exposes `/goal` in both
terminal frontends and the Web UI. Use this guide when one objective may span
several Runs. A configured model, Session storage, and normal tool permissions
are required. [Run budgets](run-budgets.md) continue to apply to each individual Run.

## MaybeCode commands

1. Start an objective with `/goal start`, adding only the budgets you require.
2. Inspect `/goal status` while the background execution proceeds.
3. Use `/goal pause` before changing Session or model configuration.
4. Use `/goal resume` to continue a resumable goal, or `/goal cancel` to end it.

The commands below are a reference; the pause, resume, and cancel commands are
separate user actions:

```text
/goal start --max-runs 8 --tokens 100000 --duration-ms 1800000 -- Inspect the project and complete the requested tests
/goal status
/goal pause
/goal resume
/goal cancel
```

`/goal` also displays status. Budget flags precede the objective; `--` ends option
processing. Run count, active execution time and token usage have no default limits.
Only explicitly supplied budgets apply. Omitted limits display as `unlimited`;
setting one budget does not add limits for the other dimensions.
Limits are positive safe integers; `maxRuns` is capped
at 10,000 and duration at 2,147,483,647 milliseconds. A goal can record at most
10,000 model calls. Session storage size limits also apply.

Existing sessions retain their saved budgets, including previously saved defaults;
the records do not distinguish defaults from user-supplied values. To start a new
goal without Run or time limits, cancel the current goal and use `/goal start <objective>`.
SDK fields `GoalState.budget.maxRuns` and `maxDurationMs` are optional; consumers
must handle `undefined` when reading them.

Starting returns once the goal is saved. Execution continues in the background.
An unfinished goal must be completed or cancelled before another can start.
Pause preserves the objective and cumulative usage. Resume accepts paused,
blocked or failed goals with remaining budget. Completed, cancelled and exhausted
goals cannot resume. Cancel permanently stops further goal execution.

Terminal Ctrl+C and Web cancellation pause the goal and cancel its current Run.
A new user message pauses the goal before submitting that message. Resume is
explicit. Session/model changes require an idle application: pause first.
Permissions continue to use the existing approval policy. The component exposes
`get_goal` and `update_goal` only during goal execution. It grants no additional
coding or shell permissions.

The model reports progress with `update_goal({ status: "active", evidence })`,
requests completion with `completed`, and reports missing user input or external
prerequisites with `blocked`. Reports requesting termination stop at a complete
tool-step boundary. Tools already present in that step can finish. Completion
records identify model-reported evidence. SDK hosts can supply an independent
`verify` callback; rejected verification becomes progress for the next Run.

## Composition

Add `@may/goal`, `@may/application`, and `@may/context` as direct dependencies.
This integration snippet assumes the host has initialized a real `model`,
`sessionStore`, `permissionPolicy`, `codingTools`, and a durable `goalStore`.
Run it in the application's async entry point:

```ts
import { GoalController } from "@may/goal";
import { AgentApplication } from "@may/application";
import { InMemoryContextFactory } from "@may/context";

const goals = new GoalController();
const application = await AgentApplication.open({
  model: goals.wrapModel(model),
  store: sessionStore,
  permissionPolicy,
  tools: codingTools,
  toolSource: () => goals.tools(),
  contextFactory: goals.wrapContextFactory(new InMemoryContextFactory()),
});
try {
  await goals.attach(application, goalStore);
  await goals.start("Complete the requested work", { maxRuns: 8 });
  await goals.wait();
} finally {
  await goals.close();
  await application.close();
}
```

`GoalAgent` requires `sessionId`, `isRunning`, `submit` and `continue`. Its run
handle exposes `id`, `result` and `cancel`. `GoalStore.read()` returns the latest
saved state or `undefined`; `write()` must acknowledge durable persistence.
Its submission and continuation options omit `stepInputSource`; the attached
Agent manages additional input and its persistence.
The host owns the Session and creates one controller per active Session.
All external operations affecting the same Agent must be serialized by the host.
Run handles can additionally implement `finalize(outcome)`, where the outcome is
`completed`, `continued`, `failed` or `cancelled`. The controller awaits this
callback after verification and durable goal-state updates, before scheduling
another Run or finishing execution. A rejected verification uses `continued`;
blocked or failed execution uses `failed`. The callback also releases resources
after cancellation and must return a consistent result when called again.
Its `result` must describe the Agent Run itself so verification can proceed;
it must not await Goal completion. MaybeCode retains its Git workspace lease
through this callback. An accepted completed Goal saves its final file version
and a host-confirmed history position, including Runs yielded for Goal scheduling.
`AgentApplication.continue(options)` is a general execution API and uses the same
mutual exclusion, cancellation and persistence path as `submit()`.

Subscribe to `goal.changed` using `goals.subscribe(listener)`. Application event
streams retain their existing consumer. Goal scheduling awaits run results and
does not consume another application's event stream. Listeners must return
normally. Background execution failures are reported through state and `wait()`;
storage failures reject `wait()` and prohibit further operations on the instance.

Goal context combines dynamic instructions with a current-host-state message in
each model request. Its content is included in context estimation and its placement
preserves the stored message count. It is regenerated after context
compaction. Original user messages remain unchanged.

The goals plugin registers active guidance in `instructionSources` at `order: 40`.
For independent hosts using their own instruction registry,
`wrapContextFactory(factory, { includeInstructions: false })` retains measurement
invalidation and the concise request-end reminder while the host registers
`goals.instructions()`. The default Context wrapper supplies the guidance itself.

`wrapModel(model, { includeInstructions: false })` meters delegated model calls
under the same Goal budget and cancellation signal while the child's Context
keeps its task instructions. The default wrapper requires `wrapContextFactory()`
for the main Agent's current Goal instructions. The delegation plugin applies
the delegated wrapper to default and role-specific child models.
Goal cancellation and duration or token exhaustion also cancel the current
execution handle, including delegated tools. A handle obtained after cancellation
is cancelled immediately, and its result and host finalization finish before the
Goal stops.

MaybeCode stores goal records under `may.goal` using application-owned Session
state. SDK callers can disable the component with `goals: false` when opening
MaybeCode. Other applications choose whether to import and connect the package.

## Verify execution and saved state

Inspect `/goal status` or `getGoal()` after a Run to confirm the objective,
status, Run count, and usage completeness. Pause and reopen the Session to
confirm the saved goal and counters remain available. Resume explicitly.
Completion must include model-reported evidence or evidence accepted by the
host's `verify` callback.

## Budgets and recovery

The goal's model wrapper records a pending call before dispatch and saves
provider-reported usage before yielding its completion. Counters survive Run
boundaries, model switches and Session reopening. The built-in summary strategy
uses the same wrapped model. Run budgets continue to apply independently.

Token checks occur at response boundaries. The final response can exceed the
remaining tokens; further execution then stops. Missing usage, interrupted calls
and failed retry attempts remain unknown. A token-budgeted goal requires host
reconciliation before resuming: `goals.reconcileUsage(callId, verifiedTokens)`.
The host must obtain the count from provider evidence. Cancellation remains
available when accounting cannot be reconciled. `/goal status` marks incomplete
usage; programmatic `getGoal()` includes call identifiers.

MaybeCode rejects token budgets with native automatic compaction or custom
summary/compaction strategies, which cannot guarantee complete accounting.
The model wrapper also rejects native compaction during a token-budgeted goal.
Native compaction's effective context size is not consumed token usage.

After an unclean exit, active goals reopen paused. Pending calls become unknown;
time since the last saved active checkpoint counts toward the duration limit.
Normal pauses exclude subsequent idle time. Existing Session recovery checks
still govern tool calls whose effects are unknown. Reopening never automatically
replays tools or resumes the goal. Saving state must succeed before execution
continues. Closing the application waits for goal cancellation and saved state.
