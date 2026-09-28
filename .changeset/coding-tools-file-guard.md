---
"@may/coding-tools": minor
---

`read`、`edit` 与 `write` 工具新增可选的 `guard` 选项。守卫收到已经过工作区路径保护
解析的路径，并在同一把按规范化路径取得的锁内执行读取或修改，因此宿主可以把
“读取并记录版本”“检查并写入”各自实现为一个完整操作边界，用于多个执行方共享
同一个工作区的场景。读取返回模型实际看到的内容，写入返回最终写入的内容。
`createCodingTool` 与 `createCodingTools` 接受同一个 `guard`，`workspaceFileKey`
提供与工具一致的路径键（含 Windows 大小写处理）。不提供 `guard` 时行为不变。
