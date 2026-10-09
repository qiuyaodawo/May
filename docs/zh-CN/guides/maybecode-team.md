# 运行 MaybeCode 多 Agent 团队

[English](../../en/guides/maybecode-team.md) | **简体中文**

使用 MaybeCode 的非交互式 `team` 命令，可以在终端运行一组持久化任务。
默认只读团队执行两项独立调查，再由管理 Agent 汇总报告并按需要委派补充工作。

执行前需要可用的[MaybeCode 配置](maybecode.md)、provider 凭据和源工作区。
团队记录必须保存在源工作区之外。本指南介绍启动团队、理解结果及管理生命周期，
计划、验收、恢复和编码分别具有独立指南。

## 运行与配置

1. 在仓库根目录执行以下命令，将工作区路径替换为需要检查的源目录：

```powershell
pnpm maybecode team run "检查这个模块的正确性风险，引用文件证据并给出最小修复建议，不修改文件。" --workspace C:\work\example --max-concurrent 2 --max-model-calls 16 --max-total-tokens 262144
```

   已安装 MaybeCode 时，将 `pnpm maybecode` 替换为 `maybecode`。下文使用已安装
   的可执行文件；在仓库执行时继续保留 `pnpm` 前缀。
2. 记录命令输出的团队 ID 和记录目录，命令结束后检查任务状态、结果文本和验收状态。
3. 后续通过 `maybecode team status <id>` 检查相同团队。创建时修改了数据目录，
   后续操作也使用相同的 `--data-directory`。

通过 `--config <path>` 和 `--model <profile>` 选择其他已配置连接。
凭据通过 provider 配置解析，保存在团队清单之外。

`--preset supervisor|pipeline|parallel` 选择编排预设；也可以用 `--plan <json-file>` 配置角色、模型档案、工具允许列表、依赖、预算和精确检查。两项互斥。计划经校验后随团队保存，恢复不会重新读取外部计划文件。详见[可配置计划](maybecode-team-plan.md)。

预设默认限制：

| 范围 | 默认限制 |
| --- | --- |
| 任务图 | 并发 2 个任务、总计 8 个任务、委派深度 2、每任务 4 轮、截止时间 10 分钟 |
| 共享模型额度 | 实际调用 32 次、总计 524,288 token、每次调用预留 32,768 token |
| 单个 Run | 10 步或模型调用、24 次工具调用、截止时间 3 分钟 |

配置中更严格的预算继续生效。自定义计划可以选择有限的任务图上限并降低角色
Run 预算。`--max-concurrent` 支持 1–8，显式 CLI 值覆盖计划的并发设置。

token 总额至少需要容纳一次 32,768 token 的模型预留，响应持久化后按实际用量
结算。provider 费用取决于实际接受的请求。用量缺失或不确定时，新模型调用会
被阻止，直到根据证据完成核对。团队模式关闭透明 provider 重试和原生压缩，
以便账本记录每次模型调用。

## 执行完成不等于验收通过

终端会显示任务状态、工具名称、指定结果任务的回答、共享用量、不可变产物，以及独立的验收状态：

- `completed` 表示执行已产生持久化结果，不表示答案正确。
- 验收 `passed` 表示所要求的当前结构化报告和配置检查对记录的工作区字节通过，不证明每条自然语言结论正确。
- 缺少检查或报告、工作区变化、检查结果未知会使验收保持 `unverified`；检查失败或当前证据无效可以使其变为 `failed`。

未配置检查时，执行完成可返回退出码 `0`，但验收仍未验证。配置检查后，退出码 `0` 还要求验收通过。执行未完成或所要求的验收未通过时为 `1`；CLI 语法错误时为 `2`。`team verify <id>` 显式运行配置检查并刷新验收。只读文件检查也可能在任务结束时运行；状态查询和恢复不会重放命令检查。详见[报告与验收](maybecode-team-verification.md)。

## 存储与生命周期

记录默认位于 `~/.may/maybecode/teams/<id>/`。`--data-directory <path>` 可以改变 MaybeCode 数据根目录，后续命令也需要使用相同参数。数据目录必须在源工作区之外。

```powershell
maybecode team status <id>
maybecode team resume <id>
maybecode team cancel <id>
maybecode team verify <id>
```

`status` 检查执行状态、失败依赖、未解决工具证据、共享用量和验证记录，不接管
正在运行的团队。跨日志视图与最近一次验收状态可能过时。`verify` 获取所有权并
运行配置检查，不调用模型。

`cancel` 写入请求，由正在运行的持有者或下一次 `resume` 消费。Ctrl+C 也会取消当前团队。取消无法撤销已经完成的 Provider 请求或工具副作用，终止检查的直接子进程也不能证明其后代进程已停止。

`resume` 使用保存的计划、权限模式、模型绑定与指纹及资源限制，不重复已完成输入。配置变化、未知副作用、未知用量以及遗留写锁会阻止继续执行。记录包含私密提示、源文件片段、工作副本、Session、预算日志、验证证据和产物；过滤秘密文件不意味着这些记录可以公开。

## 显式恢复

恢复命令分离预览、确认和执行：

```powershell
maybecode team retry <id> --task <task-id> --finding "已核实可以再次尝试的原因"
maybecode team retry <id> --task <task-id> --finding "已核实可以再次尝试的原因" --confirm <digest>
maybecode team reconcile <id> --resolution C:\work\resolution.json
maybecode team reconcile <id> --resolution C:\work\resolution.json --confirm <digest>
maybecode team resume <id>
```

第一次调用显示影响范围和摘要值，确认必须匹配该预览。重试只为一个任务排队创建新 Session/Attempt，不启动 Agent，不重置配额、不回滚副作用，也不自动重试下游依赖。核实命令为单个任务、模型用量记录或检查记录有证据的结果；任务和检查核实不能制造 `passed` 或成功答案。只有另外执行 `resume` 才继续模型工作。格式和安全要求见[恢复控制](maybecode-team-recovery.md)。

## 受控编码与权限

`--mode coding` 允许在任务私有副本中使用显式列出的 `write`/`edit` 工具，计划
不能自行开启该模式。`--allow-checks` 独立授权配置中的精确可执行文件与参数，
模型通过检查 ID 选择操作。已授权进程具有宿主权限，团队文件工具只读时也一样：
进程可以读写副本外文件、访问网络和创建后代进程。只授权已审查的命令与代码，
执行不可信代码时使用外部沙箱。依赖需要另外准备。

每个任务收到同一份过滤基线。依赖传递报告，不传递编辑：流水线评审者不会继承上一任务修改后的文件。修改不会自动合并。执行后可导出并审查所选已完成任务：

```powershell
maybecode team diff <id> --tasks analysis,review
maybecode team apply <id> --patch <patch-id> --confirm <digest>
```

写入源文件前，会检查已审查补丁、源基线、任务快照与冲突。所选任务配置的验收
必须当前有效且通过；未配置检查的所选任务会明确显示为未经验证、仅经人工审查。
每个任务的检查只验证自己的编辑。应用补丁由宿主调用，Git 提交需要单独操作。
冲突处理、备份和部分失败恢复参见[受控编码](maybecode-team-coding.md)。

工具权限、委派目标和消息能力按角色限制。默认 `supervisor` 只能委派给 `worker`，
消息能力需要计划显式开启。MCP、任意 Shell 工具、恢复控制和源文件应用均不向
团队模型开放。文件副本和排除规则只能减少意外共享；进程权限和源文件中的敏感
信息需要宿主另外检查。

## 已有团队与当前范围

已有 v1 团队保留原来的只读 `resume`、`status`、`cancel` 行为，不会静默升级到 v2 权限或验收。使用新控制能力需要新建团队。

[协作 API](coordination.md)另外提供任务图修改、移交和远程 Worker，供宿主集成。
团队使用单个协调器和本地资源账本。
