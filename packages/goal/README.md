# @may/goal

Independent, durable goal execution composed through public Agent interfaces.
The package depends on `@may/core` and `@may/context`. Base Agent packages do not
import it. Importing the package starts no execution.
`GoalAgent` uses submission and continuation options without `stepInputSource`;
the attached Agent owns any additional input and its persistence.

Run count, active execution time and token usage are unlimited unless the caller
supplies the corresponding budget. Saved goals retain their recorded limits.

Run handles may implement `finalize(outcome)`. The controller calls it after
verification and durable goal-state updates, and awaits it before another Run
or completion. Hosts can retain workspace leases through verification and
save the final file checkpoint before reporting a completed Goal.

`wrapModel(model, { includeInstructions: false })` meters delegated model calls
under the same Goal budget and cancellation signal while their own Context
retains the task's instructions. The default wrapper requires
`wrapContextFactory()` for the main Agent's current Goal instructions.

See the [English guide](../../docs/en/guides/goals.md) and
[简体中文指南](../../docs/zh-CN/guides/goals.md) for composition, budgets and recovery.
