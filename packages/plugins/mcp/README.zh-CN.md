# @may/plugin-mcp

`createMcpPlugin(options)` 提供 `mcpService`，在 setup 中连接实际 MCP pool，注册动态
工具目录，并管理 transport 的关闭。选项接受 `OpenMcpClientPoolOptions`，以及
`dataDirectory`、`enableInteractions` 和可选 `open` factory。指定数据目录时，插件
按照服务器配置创建任务记录与 OAuth credential store。Session 所有权、审批、取消、
目录版本和重新连接行为遵循 `@may/mcp`。

`createMcpHostPlugin(options)` 在 host scope 提供 `mcpHostService`，可选依赖
`observabilityHostService`，使连接在 application 和 Session 切换期间继续存在。
`createSharedMcpPlugin(pool)` 将已有 pool 的工具贡献给 application，连接仍然由
原 host 管理。关闭 host 时取消并关闭实际 transport，操作不会自动重复执行。

参见 [English version](README.md)。
