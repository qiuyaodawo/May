# 可配置的 MaybeCode 团队

[English](../../en/guides/maybecode-team-plan.md)

MaybeCode 的预设和自定义任务图共用同一个协调运行时。计划配置角色、已有模型档案、工具、依赖、检查与有界协调限制，不是另造一套 Agent 实现，也不能突破宿主显式选择的权限模式。

## 预设

```powershell
maybecode team run "检查这个模块" --preset supervisor --workspace C:\work\example
maybecode team run "分阶段评审方案" --preset pipeline --workspace C:\work\example
maybecode team run "对比独立调查结果" --preset parallel --workspace C:\work\example
```

| 预设 | 初始任务图 | 动态委派 |
| --- | --- | --- |
| `supervisor`（默认） | `analysis`、`review` 独立执行，再由 `summary` 汇总 | Supervisor 可委派给 `worker` |
| `pipeline` | `analysis` → `review` → `summary`；汇总收到前两份报告 | 禁用 |
| `parallel` | `analysis`、`review` 独立执行，再由 `summary` 汇总 | 禁用 |

依赖传递显式报告，**不会传递工作副本修改**。包括流水线阶段在内，每个任务都获得同一份过滤后基线的独立副本。评审任务不能假设前一任务的编辑已经出现在自己的副本中。编码流程会单独导出可审查的修改，计划不会自动合并它们。

## 自定义 JSON 计划

```json
{
  "format": 1,
  "name": "module-review",
  "roles": {
    "reader": {
      "model": "review-model",
      "instructions": "检查源文件并引用具体证据。",
      "tools": ["read", "list_files", "submit_report", "run_check"],
      "runBudget": { "maxModelCalls": 4, "maxToolCalls": 12 }
    },
    "summarizer": {
      "tools": ["read", "read_artifact", "submit_report"],
      "instructions": "区分已验证发现与未经验证的说法。"
    }
  },
  "tasks": [
    { "id": "inspect", "agent": "reader", "input": "检查 README.md 并解释模块约定。" },
    { "id": "final", "agent": "summarizer", "input": "汇总收到的检查报告。", "dependsOn": ["inspect"] }
  ],
  "resultTaskId": "final",
  "limits": { "maxConcurrent": 2, "maxTasks": 4, "maxDurationMs": 300000 },
  "checks": [
    { "id": "contract-present", "taskId": "inspect", "type": "file-contains", "path": "README.md", "text": "Contract" }
  ]
}
```

```powershell
maybecode team run "评审模块" --plan C:\work\review-plan.json --workspace C:\work\example
```

`model` 引用 May 配置中已有的模型档案，不接受内联提供商或凭据。未配置角色模型时使用团队选择的默认模型。`instructions` 增加角色指导，不替换宿主安全规则。任务 `input` 是字面文本，不是模板语言或 Shell 命令。`resultTaskId` 选择显示为最终结果的任务，不会免除其他任务的完成与验证要求。

省略角色工具时，默认启用 `read`、`list_files`、`publish_artifact`、`read_artifact`、`submit_report`、`run_check`。显式数组就是允许列表，也可以为空。`delegateTo` 默认为 `[]`，只能引用已定义角色。`messaging` 默认为 `false`，启用消息能力不会授予委派权限。`write`、`edit` 需要 CLI 显式选择 `--mode coding`；计划本身不允许包含 `mode`，不能自行开启编码。命令检查另外要求宿主提供 `--allow-checks` 授权，编码模式也不例外；文件检查不启动进程。

角色 `runBudget` 与 `limits.runBudget` 是单次 Run 上限，不能放宽更严格的宿主预算。实际模型调用次数与共享 token 上限仍由团队 CLI 控制，角色不能另开一个不计量的模型。报告和检查类型见[团队验证](maybecode-team-verification.md)。

## 校验与持久化

- JSON 不超过 1 MiB，最多 16 个角色、128 个初始任务。任务输入最多 65,536 UTF-8 字节，角色指令最多 16,384 字节。预设用户提示仍保持团队原有的 32,768 字节上限。
- 派发前拒绝未知字段或工具、重复 ID 或依赖、缺失角色或依赖、检查引用不存在的任务、依赖环、非法 Run 预算以及超过配额的计划。ID 为 1–128 个 ASCII 字母、数字、点、下划线或连字符，拒绝保留对象键。
- 计划协调配置的最大值为：并发 8、总任务 128、截止时间 24 小时、输出 256 KiB、深度 8、轮数 64、消息 4,096、Attempt 8、任务图修改 128。这些是解析上限，不是默认分配；预设仍采用更小的[团队默认值](maybecode-team.md)。
- 标准化计划随团队持久化。恢复使用保存的计划和固定的模型配置，不重新读取已经修改或删除的外部计划文件。编辑计划文件只影响新运行。

计划文件属于可信宿主配置：启动前应审查模型路由、工具授权、委派关系和检查命令。源文件、模型输出、同行消息和报告文本仍是不可信数据，不能借此改写计划。
