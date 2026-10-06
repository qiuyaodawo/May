# `@may/eval`

[English](README.md) | **简体中文**

重复执行 Agent 任务，验收实际结果，保存证据，并比较带有版本的配置。
案例提供输入、执行限制、环境与验收条件。实验在执行之前保存案例、配置、
重复次数、并发数量与调度 seed。

公共入口为 `@may/eval`、`@may/eval/application`、`@may/eval/coordination`
与 `@may/eval/file-store`。主入口提供 runner、组件 registry、类型、内置环境
与 evaluator，以及报告比较函数。文件存储需要 Node.js >=22.16.0。

private CLI 与可执行示例位于 `apps/eval`。在仓库目录执行：

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

suite module 是拥有宿主权限的可信程序。目录副本提供独立文件；环境声明分别
说明进程、网络与凭据的隔离能力。输出目录与 evaluator 应当保存在候选 Agent
工作目录之外。需要强制隔离的宿主提供满足案例要求的环境。

[简体中文指南](../../docs/zh-CN/guides/eval.md)与
[English guide](../../docs/en/guides/eval.md)介绍公共接口、生命周期、重启处理、
评分、证据控制、指标与验证。发布范围明确为 `@may/eval`；`@may/eval-cli`
保持 private。打包后的独立 consumer 验证完整运行依赖。
