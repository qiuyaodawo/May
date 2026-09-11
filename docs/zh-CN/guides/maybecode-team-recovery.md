# 团队检查与显式恢复

[English](../../en/guides/maybecode-team-recovery.md)

v2 团队提供宿主专用的检查、核实与重试命令。这些命令不是 Agent 工具，
不会让模型判断它自己的未知副作用是否安全。旧 v1 团队保留原来的
`resume`/`status`/`cancel` 行为，不静默获得新增权限。

## 先检查

```powershell
maybecode team status <id> --data-directory <data-root>
```

状态命令不接管正在运行的团队，而是只读检查持久化日志，显示失败原因、
未成功的依赖、Attempt 与 Session 身份、未结算工具证据、预算调用 ID 和
未知检查命令 ID。pending 检查可能仍在运行。上次验收投影会明确标注可能过期；
`team verify` 会检查当前工作区指纹。不同日志间的监控视图不是原子恢复快照。

恢复控制需要取得与运行时一致的资源和协调器独占所有权。活跃持有者或崩溃
遗留锁会阻止操作。确认旧进程停止前不要删除锁，也不能删日志强行重试。
控制命令不加载模型凭据，不构造 Provider。

## 每次核实一个明确结果

根据独立核实的证据创建 UTF-8 JSON 文件，每次选择一种 kind；没有全部清空
或重置预算命令。

```json
{
  "format": 1,
  "kind": "budget",
  "callId": "从状态中取得的准确调用ID",
  "usage": { "inputTokens": 100, "outputTokens": 20, "totalTokens": 120 },
  "finding": "已根据 Provider 对该次请求的用量记录核实。"
}
```

上述数字只是格式示例，不是缺失用量时的估算。必须填写真实用量；零用量也
需要证据。核实不会退回实际消耗、提高限额、重试请求或把旧模型结果放行给工具。

核实任务副作用后可使用：

```json
{
  "format": 1,
  "kind": "task",
  "taskId": "implementation",
  "outcome": "failed",
  "finding": "已检查记录中的工具副作用并停止遗留工作；保留部分编辑供审查。"
}
```

核实中断的确定性检查可使用：

```json
{
  "format": 1,
  "kind": "check",
  "commandId": "从状态中取得的准确检查命令ID",
  "outcome": "cancelled",
  "finding": "已确认测试进程及子进程停止，并检查其产生的文件变更。"
}
```

任务和检查只能核实为 `failed` 或 `cancelled`，不能编造成功。任务 finding
在协调层确认副作用，不改写旧 Session 历史。预算和检查是独立记录，可能仍需
分别核实。验证账本中的通过记录也不会自动关闭未知的 Session 工具检查点。

先预览，检查 finding 和摘要，再显式确认：

```powershell
maybecode team reconcile <id> --resolution resolution.json
maybecode team reconcile <id> --resolution resolution.json --confirm <digest>
```

摘要绑定 finding 和当前任务、预算、验证证据。状态或文件内容改变后需要重新
预览。确认只记录结论，不运行 Agent、工具或测试。宿主必须真正核实证据；
JSON 里的一句话是审计声明，不是自动证明。

## 重试前审查影响范围

```powershell
maybecode team retry <id> --task implementation --finding "已核实失败，显式授权一次新尝试。"
maybecode team retry <id> --task implementation --finding "已核实失败，显式授权一次新尝试。" --confirm <digest>
maybecode team resume <id>
```

预览列出受影响的下游任务和所属子任务。确认只为选中的任务分配新 Session/
dispatch 并排队；`resume` 是独立操作。派发时会再次核对持久化重试授权。
旧历史、用量和工作副本编辑都保留，重试不是回滚，也不是干净检出。

未知预算/检查副作用会阻止重试。运行时还会拒绝未知任务副作用、已被消费的结果、
不兼容的未收消息、活跃子任务、已停止/过期团队和耗尽的终身限额。上游成功后，
失败的下游任务**不会自动重试**，须分别预览与授权。已完成任务不能重试。
取消与截止时间不会静默重置；已停止团队可能需要显式新建团队，而非继续旧尝试。

## 取消与验证

`team cancel <id>` 写入取消请求，由正在运行的团队或宿主验证持有者消费。
中断的命令检查变为 unknown，不代表安全回滚；核实前必须检查遗留子进程。
`team verify <id>` 显式执行已配置检查，不清除取消状态、不重放未知命令。
参见[结果验收](maybecode-team-verification.md)和
[补丁应用](maybecode-team-coding.md)，它们保留各自的结果记录。

全部命令支持 `--data-directory`，须使用原团队的数据根目录。补丁应用失败时
保留备份与逐文件证据；这里的控制命令不会自动回滚或续跑未知的源文件应用。
