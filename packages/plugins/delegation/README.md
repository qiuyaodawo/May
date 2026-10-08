# @may/plugin-delegation

`createWorkspaceFilesPlugin({ workspace, defaultTools? })` provides
`workspaceFilesService` and registers the default coding tools when requested.
Its shared file guard serializes file access, enforces child file assignments,
requires reads before changing existing child files, and detects external changes.

`createDelegationPlugin(options)` requires that file service plus application,
model, store, permission, and composition services. It provides
`delegationService`, whose `get()` returns the actual `SubagentHost` after
`application.created`. Setup registers request-budget model wrapping, dynamic
delegation tools, and instructions. The created Hook restores request records
and initializes coordination; closing cancels active children before cleanup.

Delegation instructions use `order: 20` and are included only while
`delegate_tasks` is available. The tool description explains complete task briefs,
unique IDs, dependency timing and parent wakeup; dynamic guidance supplies shared
workspace rules, role access and request limits. Child instructions include file
assignments and the required final evidence and verification report.

Optional instruction callbacks let the host supply current child context:

- `instructionsSource()` selects base instructions when each child Session opens;
  `instructions` supplies the default content.
- `projectInstructionsSource()` supplies current workspace-root project rules in
  each instruction snapshot.
- `prepareInstructions()` runs on accepted input and before each child Run to
  refresh instruction data.
- `permissionModeSource()` supplies the current permission mode when the child
  environment is generated.

Child contributions are ordered as environment (`-80`), project rules (`-60`),
tool guidance (`-40`), Skills (`0`), assignment (`20`) and context continuity (`60`).
Environment fields identify the child's role, parent task and Session origin.

Each child retains its own Session, Run identity, permissions, Context, role
limits, and shared request ledger. Versioned plugin state preserves the request
index alongside `may.subagents` history records. Interrupted effects require
reconciliation; resume does not replay them. `SubagentHost`, configuration,
budget, file, instruction, and request types are also exported through the
package and its documented `host`, `configuration`, `budget`, `files`,
`instructions`, and `types` subpaths.

The default Context budget derives from the active Model's limits. Explicit
`contextBudget` takes priority, and role-specific models retain their separately
configured limits and Context budgets.
When `goalsService` is available, default and role-specific child models share
the Goal's token accounting, budget checks and cancellation signal. Their own
Context retains the delegated task's instructions.

When an application provides `mcpService`, delegation declares that optional
dependency and obtains the pool's current tool catalog for each child Run.
Child tool calls keep their own Session identity, permissions and request budget.

Read the [Chinese version](README.zh-CN.md).
