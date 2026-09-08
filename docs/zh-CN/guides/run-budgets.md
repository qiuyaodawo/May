# 运行预算

[English](../../en/guides/run-budgets.md)

`May`、`AgentApplication`、`defineAgent` 和 MaybeCode 支持 `runBudget` 默认限制。
`run()` / `submit()` / `continue()` 可以收紧但不能放宽它们。每个 Run，包括显式
retry/continue，都获得新预算；它不是 Session 的终身配额。

MaybeCode 支持以下配置：

```json
{
  "apps": {
    "maybecode": {
      "runBudget": {
        "maxDurationMs": 300000,
        "maxSteps": 12,
        "maxModelCalls": 12,
        "maxToolCalls": 30,
        "maxTotalTokens": 100000
      }
    }
  }
}
```

限制为可选正数，除美元金额外必须是整数。现有 `maxSteps` 仍构成额外上限，默认 16。
整个工具批次开始执行前会预留调用额度，包括并行调度。模型计数统计获准进入的循环步骤，
不统计 provider HTTP 重试。

成本上限使用 `maxCostUsd`，并必须配置 `tokenPrices` 中的 `inputUsdPerMillion` 和
`outputUsdPerMillion`。May 不猜测费率。费率必须有限且非负，单次运行不能覆盖宿主费率。
切换模型仍保留这些费率，价格假设改变时需更新配置。

`RunResult.budget` 报告耗时、获准步骤／模型调用、预留工具调用、已知 token、估算成本和
`usageComplete`。Token 使用 provider 总量或输入输出之和。缺少必要用量会以
`RUN_BUDGET_USAGE_UNAVAILABLE` 停止；没有 token／成本上限时标记用量不完整。
未配置费率时成本字段为零。

超限会持久化 `run.budget.exceeded`，记录维度、限制、消耗和快照，随后产生
`run.failed` / `RUN_BUDGET_EXCEEDED`。两个终端界面都显示原因。未执行调用会在继续前
被关闭。时限通过 AbortSignal 传递到上下文准备、模型、审批和工具；清理会等待已开始
工具结束，进程内契约无法强制终止不响应取消的适配器。

Token／成本在响应边界检查，因此最后一次请求可能超限；没有返回用量的 HTTP 重试也无法
精确计费。Core 模型循环以外的辅助调用（手动摘要、压缩模型、隔离 MCP sampling、
远程工具内部工作）不计入这些 token／调用计数，需要宿主另设预算。这不是 provider
账单的硬上限。
