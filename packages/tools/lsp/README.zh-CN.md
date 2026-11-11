# @sortedyuan/lsp-tools

[English](README.md) | **简体中文**

为 May 提供 stdio 语言服务器管理和七个工作区工具。要求 Node >= 22.16.0。
仅启动 `servers` 中显式列出的服务器，并在首次使用时启动。

```ts
import { openCodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import { openLanguageServerManager, createLspTools } from "@sortedyuan/lsp-tools";

const execution = await openCodingExecutionEnvironment({
  workspace: process.cwd(),
  isolation: { mode: "host" },
});
const manager = await openLanguageServerManager({
  execution,
  dataDirectory: ".may",
  servers: [{ id: "typescript" }, { id: "python" }],
});
const tools = createLspTools(manager);
// 将 tools 注册到运行环境，并将 manager.fileFeedback 传入 edit/write。
await manager.close();
await execution.close();
```

内置预设：

May 要求 Node >= 22.16.0。安装的语言服务器有各自的运行环境要求；
typescript-language-server 6.0.3 要求 Node >= 22.22.2。

| id         | 命令                               | 安装方式                                             |
| ---------- | ---------------------------------- | ---------------------------------------------------- |
| typescript | typescript-language-server --stdio | npm install -g typescript-language-server typescript |
| python     | pyright-langserver --stdio         | npm install -g pyright                               |
| rust       | rust-analyzer                      | rustup component add rust-analyzer rust-src          |
| go         | gopls                              | go install golang.org/x/tools/gopls@latest           |

每个定义接受 `command`、`args`、`languages`（languageId 到扩展名数组）、`settings`、
`initializationOptions` 和 `env`。内置定义可以逐字段覆盖。
新 id 必须提供 `command` 和 `languages`。重复扩展名会被拒绝。
主机模式下，npm 服务器优先从工作区解析，随后查找 PATH；Windows 全局 npm
`.cmd` 启动器通过其 package 的 JavaScript 入口启动，整个过程不调用 shell。
容器服务器需要安装在镜像中。工作区内的 npm 入口使用映射路径和镜像中的 `node`。

工具名称为 `lsp_diagnostics`、`lsp_definition`、`lsp_references`、`lsp_hover`、
`lsp_document_symbols`、`lsp_workspace_symbols` 和 `lsp_rename`。
位置接受 `path`、从 1 开始的 `line`，以及 `symbol` 或从 1 开始的 UTF-16 `column`，
两者必须提供其中一个。`symbol` 可以附带从 1 开始的 `occurrence`。
工作区符号需要 `language`（配置的服务器 id）和 `query`。
引用接受 `includeDeclaration`，默认为 false。重命名需要 `newName`。

诊断状态为 `complete`、`pending`、`unknown` 或 `unavailable`。
只有与请求文档版本对应的报告才能获得 `complete`。
服务器发布没有版本号的诊断时，状态为 `unknown`，并提供时间戳。
typescript-language-server 6.0.3 发布没有版本号的诊断。
编辑成功后，反馈错误返回 `unavailable`。调用方取消操作时仍然抛出错误。
反馈默认包含 error 和 warning 诊断。

审批重命名时，调用 `createRenamePreview(manager, input, toolCallId, signal)`，
随后使用相同的 input 和 toolCallId 执行工具。
预览类型为 `maybecode.lsp-rename-preview`，各个文件的差异由 coding-tools 提供。
宿主可以通过管理器选项或 `createLspTools(manager, { guard })` 提供 `WorkspaceFileGuard`。
工具通过 `runMany` 同时保护所有修改文件。
计划生成后文件发生变化时，在写入任何文件之前抛出 `LspRenameConflictError`。
计划仅接受文本编辑，最多 100 个文件、5000 处编辑。
重命名事务持久化到 `dataDirectory/lsp-rename/<workspace SHA-256>.json`。
打开管理器时，在返回之前恢复中断的事务。
`status()` 报告恢复信息、进度、错误、有大小限制的协议日志、stderr 和解析后的命令。

选项默认值为 `startTimeoutMs: 60000`、`requestTimeoutMs: 15000`、
`diagnosticsTimeoutMs: 3000`、`shutdownTimeoutMs: 5000`、`maxFileBytes: 1048576`、
`maxResults: 200`、`maxHoverChars: 8000`、`maxEditDiagnostics: 20`、
`maxDiagnostics: 200`、`maxServers: 4`。每个服务器最多打开 64 个文档；
协议日志和 stderr 各自限制为 64 KiB。`diagnosticSeverities` 控制报告的严重程度。
只读查询收到 ContentModified 时重试一次；pull 诊断收到 ServerCancelled 且
`retriggerRequest: true` 时也重试一次。重命名请求不重试。
取消和超时会发送 `$/cancelRequest`。连续三次快速退出后，需要执行 `restart(id)` 才能继续请求。

运行 `pnpm --filter @sortedyuan/lsp-tools test` 执行真实 TypeScript 和 Python 测试。
package 将服务器的 tsserver 运行版本固定为 TypeScript 5.9.3。
运行 `pnpm test:integration:lsp` 测试 Rust 和 Go，两个命令都必须在 PATH 中可用。
设置 `MAY_LSP_TEST_IMAGE` 可以同时执行容器测试，镜像需要包含服务器、Node、Go、
Rust 源码和缓存的项目依赖。容器执行需要满足 coding-tools 的镜像要求，并保持
`network: "none"`。
