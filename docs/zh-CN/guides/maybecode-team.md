# MaybeCode 多 Agent 团队

[English](../../en/guides/maybecode-team.md)

MaybeCode 的非交互式 `team` 命令可以在终端运行有界、持久化的多 Agent 调研任务，复用普通 MaybeCode 的 May 配置和命名模型。当前产品预设是**只读模式**：两个独立 Worker 调查任务，再由 Supervisor 汇总证据；Supervisor 也可以委派小规模补充调查。

## 运行团队

在本仓库中执行：

```powershell
pnpm maybecode team run "检查这个模块的正确性风险，引用文件证据并给出最小修复建议，不修改文件。" --workspace C:\work\example --max-concurrent 2 --max-model-calls 16 --max-total-tokens 262144
```

如果已安装当前版本，将 `pnpm maybecode` 换成 `maybecode`。可以通过 `--config <path>` 和 `--model <profile>` 选择其他已配置连接。凭据沿用现有 Provider 配置解析，不会打印或复制到团队清单。

终端会显示团队 ID、各任务状态与工具名称、Supervisor 最终回答、共享用量及不可变产物引用。团队成功时退出码为 `0`；失败、取消、等待或恢复受阻时为 `1`；CLI 语法错误时为 `2`。

默认限制为：并发 2 个任务、总计 8 个任务、委派深度 2、每任务 4 轮、团队时限 10 分钟、32 次物理模型调用、共享 524,288 token。每个 Run 还限制为 10 步/次模型调用、24 次工具调用、3 分钟，已有配置中更严格的 Run 预算仍然生效。`--max-concurrent` 支持 1–8。token 总额至少要容纳一次 32,768 token 的模型预留；响应持久化后，以实际用量替换预留。这不是 Provider 费用的预付硬保证。Provider 用量缺失或不确定时，后续模型调用会被阻止，直到宿主完成有证据的核对。团队模式不启用透明 Provider 重试或原生压缩，避免漏记调用。

## 存储、状态、恢复和取消

记录默认位于 `~/.may/maybecode/teams/<id>/`。`--data-directory <path>` 可以改变 MaybeCode 数据根目录，后续命令也需要使用相同参数。数据目录必须在源工作区之外。

```powershell
maybecode team status <id>
maybecode team resume <id>
maybecode team cancel <id>
```

`status` 读取进度投影，不接管正在执行的运行时；该投影不是恢复依据。`cancel` 写入取消请求，由正在运行的持有者消费并取消团队。如果没有进程持有团队，下一次 `resume` 会消费请求并记录取消，不派发新工作。Ctrl+C 也会取消当前团队。取消无法撤销已经完成的 Provider 请求或工具副作用。

`resume` 使用原工作区、模型配置名称、路由/选项指纹与已保存的资源限制，不重复已完成输入。配置变化、未知工具副作用或未知模型用量会阻止继续执行。CLI 不会编造恢复结论，也不会抢占遗留写锁，这些情况需要宿主检查。数据目录包含隔离工作区、Session、协作快照、共享预算记录和不可变 UTF-8 产物。虽然工作区副本会过滤凭据文件，这些记录仍包含任务提示和选定源文件片段，应按私密数据保管。

## 权限和隔离

- 每个任务得到同一份已过滤基线的独立副本；后续任务看到的仍是初始文件，而不是源工作区中的并发修改。产物不会自动合并回源工作区。
- 读取和有界目录列举只作用于任务副本。不提供 Shell、源文件编辑、MCP，也不继承审批授权。
- 只有 Supervisor 可以委派，目标只能是 Worker。产品显式允许团队内任务消息及已发布产物的读取，未知工具一律拒绝。
- 最终回答会自动发布为不可变产物；Agent 也可以发布文本产物并共享精确引用。
- 此预设不是进程沙箱。过滤规则只能减少意外包含秘密的情况，无法证明每个允许的源文件都没有敏感信息。请选择适合发送给所配置 Provider 的工作区。

这个 CLI 预设有意比可复用的[协作 API](coordination.md)更窄。Handoff、宿主管理的重试、任务图编辑及远程 Worker 由宿主应用组合，不作为无约束的终端模型工具开放。
