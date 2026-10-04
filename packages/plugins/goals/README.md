# @may/plugin-goals

`createGoalsPlugin(options?)` provides `goalsService`, a `GoalController`, and
registers its model wrapper, Context wrapper, and dynamic tools through the
composition services. It requires application access and the corresponding
registries. `application.created` attaches the controller to the actual Session;
`application.beforeClose` stops scheduled work before resources are disposed.

Goal state is versioned in plugin state and preserves the existing `may.goal`
Session record for history consumers. Resume retains completed goals and pauses
interrupted goals for explicit user continuation. Token accounting uses actual
provider usage. `validateBudget` and `verify` retain their `@may/goal` meanings.
`createAgent(application)` can route goal Runs through an owned delegation host.
The controller exposed by `goalsService` supports
`wrapModel(model, { includeInstructions: false })` for delegated token accounting,
budgets and cancellation with the child's task instructions.

Read the [Chinese version](README.zh-CN.md).
