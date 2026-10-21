# `@sortedyuan/coordination/plugin`

**English** | [简体中文](plugin.zh-CN.md)

`createCoordinationPlugin({ id? })` creates a `host` scope plugin providing
`coordinationService`. Its `create(options)` and `resume(options)` accept the full
`CoordinationRuntime` options. The host supplies Agents, policies and storage.

`release(runtime)` closes the runtime and removes it from the managed set. Call it
after completing a task graph to release its resources. Plugin shutdown waits for
pending creation and closes every remaining runtime. A runtime created while its
scope is closing is closed before its creation request rejects. Repeated runtime
closure retains the runtime's existing behavior.

Tests read actual files and compute SHA-256 results, covering completion, resume,
repeated cleanup and writer ownership acquisition. Run
`pnpm --filter @sortedyuan/coordination test`.
