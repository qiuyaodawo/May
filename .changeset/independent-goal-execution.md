---
"@may/goal": minor
"@may/application": minor
---

Add independently composed durable goal execution, continuation with optional budgets, model tools,
usage accounting and recovery. Expose general AgentApplication.continue() without
adding a dependency on goal execution to base Agent packages.

MaybeCode integrates /goal start, status, pause, resume and cancel in its terminal
and Web interfaces, retaining the existing permission policy and session storage.

Run count and active execution time have no default limits. Explicit budgets remain
enforced and previously saved budgets retain their values. Breaking SDK type change:
GoalState.budget.maxRuns and maxDurationMs are optional; SDK consumers must handle
undefined values as unlimited budgets.
