# MaybeCode 多 Agent 团队

[English](../../en/guides/maybecode-team.md)

MaybeCode 的非交互式 `team` 命令可以在终端运行有界、持久化的多 Agent 任务，复用 May 配置和命名模型。新建的 v2 团队支持可配置计划、结构化证据与验收、显式恢复控制以及经审查的编码补丁。默认仍是**只读模式**：两个独立 Worker 调查，再由 Supervisor 汇总，并可委派小规模补充任务。

## 运行与配置

在本仓库中执行：

```powershell
pnpm maybecode team run "检查这个模块的正确性风险，引用文件证据并给出最小修复建议，不修改文件。" --workspace C:\work\example --max-concurrent 2 --max-model-calls 16 --max-total-tokens 262144
```

如果已安装当前版本，将 `pnpm maybecode` 换成 `maybecode`。可以通过 `--config <path>` 和 `--model <profile>` 选择其他已配置连接。凭据沿用现有 Provider 配置解析，不会打印或复制到团队清单。

`--preset supervisor|pipeline|parallel` 选择编排预设；也可以用 `--plan <json-file>` 配置角色、模型档案、工具允许列表、依赖、预算和精确检查。两项互斥。计划经校验后随团队保存，恢复不会重新读取外部计划文件。详见[可配置计划](maybecode-team-plan.md)。

预设默认限制为：并发 2 个任务、总计 8 个任务、委派深度 2、每任务 4 轮、团队时限 10 分钟、32 次物理模型调用、共享 524,288 token。每个 Run 还限制为 10 步/次模型调用、24 次工具调用、3 分钟；已有配置中更严格的预算仍然生效。自定义计划可选取其他有界协调限制，并收紧各角色的 Run 预算。`--max-concurrent` 支持 1–8；显式 CLI 值覆盖计划的并发设置。

token 总额至少要容纳一次 32,768 token 的模型预留。响应持久化后，以实际用量替换预留；这不是 Provider 费用的预付硬保证。用量缺失或不确定时，新模型调用会被阻止，直到完成有证据的核对。团队模式不启用透明 Provider 重试或原生压缩，避免漏记调用。

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

`status` 检查执行状态、失败依赖、未解决工具证据、共享用量和验证记录，不接管正在执行的持有者。跨日志视图与最近一次验收投影可能过时。`verify` 获取所有权并运行配置检查，不是另一次模型运行。

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

`--mode coding` 允许在任务私有副本中使用显式列出的 `write`/`edit` 工具，计划不能自行开启该模式。`--allow-checks` 独立授权配置中的精确可执行文件与参数，模型选择检查 ID，而不是任意命令。**已授权进程没有 OS 沙箱**，团队文件工具只读时也一样：进程可以读写副本外文件、访问网络和派生后代进程。只授权已审查的命令与代码，或使用外部沙箱；不会自动安装依赖。

每个任务收到同一份过滤基线。依赖传递报告，不传递编辑：流水线评审者不会继承上一任务修改后的文件。修改不会自动合并。执行后可导出并审查所选已完成任务：

```powershell
maybecode team diff <id> --tasks analysis,review
maybecode team apply <id> --patch <patch-id> --confirm <digest>
```

写入源文件前，会检查已审查补丁、源基线、任务快照与冲突。所选补丁任务配置的验收必须当前有效且通过。未配置检查的所选任务会明确显示为未经验证、仅经人工审查；不能借用另一任务的绿灯证明这些编辑正确。应用补丁属于宿主操作，不是模型工具，也不是 Git 提交。冲突处理、备份和部分失败恢复见[受控编码](maybecode-team-coding.md)。

工具权限、委派目标和消息能力按角色限制。默认 Supervisor 只能委派给 Worker，消息能力默认关闭，除非计划显式开启。MCP、任意 Shell 工具、恢复控制和源文件应用均不向团队模型开放。副本和排除规则只能减少意外共享，不是安全沙箱，也不保证源文件不含秘密。

## 已有团队与当前范围

已有 v1 团队保留原来的只读 `resume`、`status`、`cancel` 行为，不会静默升级到 v2 权限或验收。使用新控制能力需要新建团队。

终端组合仍比可复用的[协作 API](coordination.md)更窄：无约束任务图修改、Handoff 和远程 Worker 托管仍属于宿主集成，不是模型可自行授予的能力。本轮没有增加分布式协调器所有权或跨主机全局配额服务。
