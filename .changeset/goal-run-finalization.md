---
"@may/goal": minor
"@may/plugin-delegation": patch
"@may/plugin-goals": patch
---

Allow Goal Run handles to finalize host resources after verification and durable goal-state updates. Finalization receives completed, continued, failed or cancelled outcomes and finishes before another Run begins, enabling final file checkpoints and workspace leases that remain active during verification.

Allow delegated model calls to share Goal token accounting, budgets and cancellation while retaining their own task instructions. Apply this wrapper to both default and role-specific child models, so delegated work can execute within an active Goal.

Expose the updated controller through goalsService. Goal cancellation and budget exhaustion cancel the current execution handle, including delegated tools and executions whose handles arrive after cancellation, and await host finalization before finishing.
