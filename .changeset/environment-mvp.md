---
"@may/environment": minor
"@may/coding-tools": minor
---

新增 `@may/environment`，提供 Windows AppContainer 执行环境、文件访问、命令输出与取消、二进制产物导出，以及远程环境创建和连接接口。创建环境时验证隔离运行能力，关闭时保留宿主工作区和导出的产物。

`@may/coding-tools` 新增可选 `environment`，通过同一个环境执行 `read`、`edit`、`write` 和 `shell`。使用环境时需要显式配置 shell profile；文件守卫的路径标识包含环境身份和环境平台。不配置环境时保留已有执行方式。
