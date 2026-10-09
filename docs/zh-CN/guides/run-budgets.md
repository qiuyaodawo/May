# 配置运行预算

[English](../../en/guides/run-budgets.md) | **简体中文**

`runBudget` 限制单次 Agent 执行的时间、步骤、调用、token 或费用。
本文介绍 MaybeCode 配置和通用代码 API。Token 与费用限制需要所选 Provider 报告用量。

## 设置默认限制

`May`、`AgentApplication`、`defineAgent` 和 MaybeCode 支持 `runBudget` 默认限制。
`run()` / `submit()` / `continue()` 可以收紧但不能放宽它们。每个 Run，包括显式
retry/continue，都获得新预算；预算范围为单个 Run。

在 MaybeCode 配置文件中加入以下对象。文件位置和优先级见
[配置参考](../reference/configuration.md)：

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

限制为可选正数，除美元金额外必须是整数。现有 `maxSteps` 仍构成额外上限：`May` 默认为 16，
MaybeCode 的主 Run 默认为 32，子 Agent 的子 Run 默认为 24。
整个工具批次开始执行前会预留调用额度，包括并行调度。模型计数统计获准进入的循环步骤，
不统计 provider HTTP 重试。

可用限制字段如下：

| 字段 | 单位与统计边界 |
| --- | --- |
| `maxDurationMs` | 当前 Run 的毫秒数 |
| `maxSteps` | 获准进入的 Agent 循环步骤 |
| `maxModelCalls` | 获准模型调用，Provider HTTP 重试独立计算 |
| `maxToolCalls` | 预留工具调用，包括下一个完整批次 |
| `maxTotalTokens` | Provider 报告的 token 用量，在响应返回时检查 |
| `maxCostUsd` | 完整 USD 费用，在响应返回时检查 |

## 为费用限制配置价格

成本上限使用 `maxCostUsd`，并明确配置 `pricing` 或兼容的 `tokenPrices`。
`tokenPrices` 保留 `inputUsdPerMillion` 和 `outputUsdPerMillion`，还支持可选的
`cachedReadUsdPerMillion`、`cachedWriteUsdPerMillion` 和 `reasoningUsdPerMillion`。
May 不猜测费率。费率必须有限且非负，单次运行不能覆盖宿主价格。切换模型保留宿主费率。

`pricing` 提供具有身份与版本的价格配置：

```ts
const pricing = {
  id: "project-model-prices",
  version: "2026-10-05",
  source: "host configuration",
  effectiveAt: "2026-10-05T00:00:00Z",
  currency: "USD",
  inputPerMillion: 2,
  outputPerMillion: 8,
  cachedReadPerMillion: 0.2,
  cachedWritePerMillion: 3,
  reasoningPerMillion: 8,
};
const runBudget = { maxCostUsd: 1, pricing };
```

示例费率用于说明 API。`pricing.items` 按计量项目的 id 设置价格，每项包含 `unit` 与
`perUnit`。代码集成可以提供 `usagePricer(usage, pricing)`，返回 `UsageCost`：金额、
币种、`estimated` 或 `provider` 类型、完整性与缺失原因。宿主遥测可以通过
`priceUsage()` 使用相同接口。JSON 配置支持价格配置；回调通过代码 API 提供。

## 理解 Provider 用量

`Usage` 支持 `cachedReadTokens`、`cachedWriteTokens`、`reasoningTokens`、其他
`items`、`completeness` 和 provider 上报的 `reportedCost`。`tokenRelations` 说明明细
是否包含在 `input`、`output`、`total` 中，或者独立于这些用量（`none`）。缺少关系时
保持 unknown。有单独费率的输入或输出子集从所属基础用量中扣除，随后单独计价；
没有单独费率时使用所属基础用量的费率。独立上报的明细必须提供自己的费率。
`total` 表示该项目仅包含在 `totalTokens`，`inputTokens` 和 `outputTokens` 均不包含
该项目。这些明细单独计价，并在 provider 总量中计算一次；`none` 明细增加到 provider
总量。`resolveUsageTotals()` 与 `priceUsage()` 会拒绝小于已声明独立组成部分的总量。
Provider 未明确项目所属用量时，使用 `unknown`，计价结果保持不完整。

OpenAI Responses 与兼容 adapter 保存缓存和 reasoning 明细，并注明输入或输出的包含
关系。Anthropic 缓存用量独立于 `input_tokens`，计算规范化总量时包含这些用量。
其他 provider 计量保留项目身份、单位、数量和与上报金额的关系。未知单位或缺少费率
使计价结果不完整。Provider 上报金额保留币种与来源，May 不进行汇率转换。

## 检查结果与预算错误

`RunResult.budget` 报告耗时、获准步骤／模型调用、预留工具调用、已知 token、成本、
`usageComplete`、`costComplete`、`costKind` 和 `latestCost`。`latestCost` 保留价格
身份、版本、来源、有效时间与缺失原因；`costKind` 可以是 estimated、provider 或跨
调用的 mixed。未知金额不增加 `costUsd`，并注明费用统计不完整。缺少预算要求的用量
时，以 `RUN_BUDGET_USAGE_UNAVAILABLE` 停止。`maxCostUsd` 要求完整的 USD 计价。
其他币种可以用于遥测计价。`aggregateUsage()` 保留计量明细，存在响应用量缺失时
将合计结果标记为 partial。

Schema 或能力验证拒绝的已完成响应仍然消耗已知的 provider 用量。
`ModelResponseValidationError` 保存这些用量以及可选的已计算费用，Run 预算计账一次，
响应继续保持失败。`RunBudgetMeter.recordUsage(usage, preparedCost?)` 可以使用经过
验证的计价结果。计价过程抛出异常时，预算保留已知 token 数量，标记费用不完整，
清除 `latestCost`，并继续传播计价错误。

超限会持久化 `run.budget.exceeded`，记录维度、限制、消耗和快照，随后产生
`run.failed` / `RUN_BUDGET_EXCEEDED`。两个终端界面都显示原因。未执行调用会在继续前
被关闭。时限通过 AbortSignal 传递到上下文准备、模型、审批和工具；清理会等待已开始
工具结束，进程内接口无法强制终止不响应取消的 adapter。

## 验证限制并理解适用范围

通过所选真实 Provider 执行有限请求，检查 `RunResult.budget` 的计数和完整性。
Token 或费用预算所需用量无法取得时，应报告 `RUN_BUDGET_USAGE_UNAVAILABLE`。
任一维度耗尽时，结果和历史应报告 `RUN_BUDGET_EXCEEDED`。

Token／成本在响应边界检查，因此最后一次请求可能超限；没有返回用量的 HTTP 重试也无法
精确计费。Core 模型循环以外的辅助调用（手动摘要、压缩模型、隔离 MCP sampling、
远程工具内部工作）不计入这些 token／调用计数，需要宿主另设预算。Provider 费用已经
发生后，响应边界检查无法撤销费用。
