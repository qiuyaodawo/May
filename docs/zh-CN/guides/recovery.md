# 崩溃恢复

[English](../../en/guides/recovery.md)

Session 使用 Core 的 `RunOptions.checkpoint` 等待式持久化检查点。运行开始、
完整模型响应、工具开始和每个工具的执行结果必须落盘后，依赖它们的工作才能继续。
串行批次中，前一个工具结果未持久化时，后一个工具不会启动。免审批工具也遵循这些
检查点。工具开始检查点在权限判断之前，因此等待审批时发生的中断也保守视为结果未知。

`Session.resume()` 为未结束的运行写入原子的 `run.interrupted` 记录。已完成结果会保留；
没有工具开始检查点的调用以 `TOOL_NOT_EXECUTED` 结束，已开始但没有结果的调用以
`TOOL_OUTCOME_UNKNOWN` 结束。缺少检查点版本元数据的旧日志，将所有未结束调用视为未知。
恢复过程不会重放工具，也不会调用模型。

未知结果会阻止 submit 和 continue，并抛出 `SESSION_RECOVERY_REQUIRED`。
`listRecoveries()` 返回原始输入，其 `id` 是原调用的稳定幂等键。宿主需要检查外部系统，
然后调用 `resolveRecovery(id, verifiedFinding)`。核实结论会持久化并加入模型上下文；
解决恢复项不会执行工具。重新打开会保留未解决项，不会重复写入中断记录。

MaybeCode 的两个终端界面都支持 `/recovery` 查看未解决项，然后记录核实结论：

```text
/recovery resolve run_id:1:call_id 已检查目标系统：记录已经存在，不要重复创建。
```

解决全部未知结果后，提交新的指令继续工作。自定义 UI 可以使用 controller 上的同名方法。

持久化失败后，必须重新打开 Session 才能继续。FileSessionStore 确认写入前执行同步，
读取时修复没有换行终止符的末尾记录；已换行的损坏记录仍会报错。每个会话仅支持一个
写入者。这些保证针对进程崩溃和存储确认，不代表分布式事务或任意外部系统的恰好一次
执行。远程工具应实现幂等或结果查询，恢复结论提供宿主显式核实外部结果的通道。
