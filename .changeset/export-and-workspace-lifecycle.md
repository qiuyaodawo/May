---
"@may/observability": patch
"@may/coordination": patch
---

`BatchSpanProcessor` 在 exporter 同步抛出错误后能够完成 `forceFlush()` 和 `shutdown()`，
并继续导出后续批次。重复调用 `TaskWorkspaceManager.prepare()` 保留目录校验，
不再追加相同的 workspace 状态记录。
