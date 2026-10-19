---
"@sortedyuan/core": minor
"@sortedyuan/application": minor
"@sortedyuan/plugin-delegation": minor
"@sortedyuan/coding-tools": patch
"@sortedyuan/session-tools": patch
"@sortedyuan/coordination": patch
"@sortedyuan/goal": patch
"@sortedyuan/skills": patch
"@sortedyuan/plugin-history-memory": patch
"@sortedyuan/tui": patch
"@sortedyuan/web-ui": patch
---

Add trusted Tool.workspaceEffect metadata, an approved-tool execution check, deferred
Git workspace initialization, and lightweight repository summaries. Delegated Agents
can share the host's execution check. Built-in file readers and session coordination
tools declare that they preserve workspace files.

MaybeCode prepares checkpoints immediately before the first approved modifying tool
in each request, sharing preparation across main and delegated Agents and retaining
the lease through Goal verification. Startup and read-only requests leave Git state
unchanged. Each modifying request saves existing user edits before accepting tool writes.
