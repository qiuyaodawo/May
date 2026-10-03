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

When an application provides `mcpService`, delegation declares that optional
dependency and obtains the pool's current tool catalog for each child Run.
Child tool calls keep their own Session identity, permissions and request budget.

Read the [Chinese version](README.zh-CN.md).
