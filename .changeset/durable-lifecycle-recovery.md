---
"@may/session": patch
"@may/plugin": patch
"@may/context": minor
"@may/application": patch
"@may/coordination": patch
"@may/coding-tools": patch
---

修复 Session 文件对 `input.generated` 的读取校验，使 Hook 追加的继续执行消息和分支继承的已交付补充输入能够恢复。

Plugin replacement 等待已接受的状态更新完成保存，并在替换准备期间拒绝新的状态写入。

ContextController 新增可选的 `commitCompaction(result)`，用于标记替换后的 Context 已经成功保存。AgentApplication 在保存成功后调用该方法；完成 Hook 的错误继续传递，活动 Context 和持久化记录保持一致。

Remote CoordinationWorker 将已保存的取消意图发送给分离的外部执行，并通过恢复查询确认结果。

PowerShell shell 工具根据最后执行命令的状态返回 exitCode，失败的 cmdlet 返回非零值。
