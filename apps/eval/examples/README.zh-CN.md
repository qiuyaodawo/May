# 可执行评估 suite

[English](README.md) | **简体中文**

suite 在每个独立目录启动真实 Node.js 命令。命令读取 `input.json`，写入
`result.json`，并通过独立命令、JSON Schema 与文件变化检查完成验收。
两次重复执行同时运行。这个案例是用于生命周期验证的确定性文件任务，记录
说明命令执行情况。真实模型评估使用公共 Agent adapters。

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

`MAY_EVAL_EXAMPLE_ID` 可以指定新的实验身份。`MAY_EVAL_EXAMPLE_WORKSPACE_ROOT`
可以覆盖工作目录根路径 `.eval-workspaces`。
execution adapter 启用 Node 的 `--permission` 模式，允许读取脚本与工作目录，
写入工作目录。verifier 对 frozen 目录使用相同限制。子进程、worker、native
addon 与 WASI 保持禁用，每个受控命令可以在直接启动的进程退出后确认终止。
suite 只使用可信程序。suite 加载与证据处理拥有宿主权限；强制隔离需要宿主
提供声明了所需能力的环境。
