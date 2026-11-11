# @sortedyuan/lsp-tools

**English** | [简体中文](README.zh-CN.md)

Stdio language server management and seven workspace tools for May. Requires Node >= 22.16.0. Servers run only when explicitly listed in `servers`, and start when first used.

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
// Register tools with your runtime; pass manager.fileFeedback to edit/write.
await manager.close();
await execution.close();
```

Built-in presets:

May requires Node >= 22.16.0. Installed language servers have their own runtime
requirements; typescript-language-server 6.0.3 requires Node >= 22.22.2.

| id         | command                            | installation                                         |
| ---------- | ---------------------------------- | ---------------------------------------------------- |
| typescript | typescript-language-server --stdio | npm install -g typescript-language-server typescript |
| python     | pyright-langserver --stdio         | npm install -g pyright                               |
| rust       | rust-analyzer                      | rustup component add rust-analyzer rust-src          |
| go         | gopls                              | go install golang.org/x/tools/gopls@latest           |

Each definition accepts `command`, `args`, `languages` (languageId to extension array), `settings`, `initializationOptions`, and `env`. Built-in definitions can be overridden field by field. New ids require `command` and `languages`. Duplicate extensions are rejected. Host npm servers are resolved from the workspace first, then PATH; Windows global npm `.cmd` launchers are resolved to their package's JavaScript entry point without invoking a shell. Container servers must be installed in the image. Container npm entry points inside the workspace use mapped paths and the image's `node`.

Tools: `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, and `lsp_rename`. Positions accept `path`, a one-based `line`, and exactly one of `symbol` (optional one-based `occurrence`) or a one-based UTF-16 `column`. Workspace symbols require `language` (configured server id) and `query`. References accept `includeDeclaration`, default false. Rename requires `newName`.

Diagnostics carry `complete`, `pending`, `unknown`, or `unavailable` status. Only a report associated with the requested document version receives `complete`. Servers publishing unversioned diagnostics receive `unknown`, with a timestamp. In particular, typescript-language-server 6.0.3 publishes unversioned diagnostics. Feedback errors are returned as `unavailable` after the edit succeeds. Caller cancellation remains an error. Feedback includes error and warning diagnostics by default.

For rename approvals call `createRenamePreview(manager, input, toolCallId, signal)`, then execute the tool with the same input and `toolCallId`. The preview uses presentation kind `maybecode.lsp-rename-preview`; its per-file changes come from coding-tools. Hosts can provide a `WorkspaceFileGuard` through manager options or `createLspTools(manager, { guard })`. The tool uses `runMany` to protect every changed file together. A file change after planning raises `LspRenameConflictError` before any file is written. Plans accept text edits only, at most 100 files and 5000 edits. Rename transactions are durably recorded under `dataDirectory/lsp-rename/<workspace SHA-256>.json`. Opening a manager recovers an interrupted transaction before returning. `status()` reports recovery, progress, errors, bounded protocol logs, stderr and resolved commands.

Options and defaults: `startTimeoutMs: 60000`, `requestTimeoutMs: 15000`, `diagnosticsTimeoutMs: 3000`, `shutdownTimeoutMs: 5000`, `maxFileBytes: 1048576`, `maxResults: 200`, `maxHoverChars: 8000`, `maxEditDiagnostics: 20`, `maxDiagnostics: 200`, `maxServers: 4`. Document capacity is 64 per server; protocol logs and stderr are bounded to 64 KiB each. `diagnosticSeverities` controls reported severities. Read-only queries retry ContentModified once; pull diagnostics additionally retry ServerCancelled with `retriggerRequest: true`. Rename requests are not retried. Cancellation and timeouts send `$/cancelRequest`. Three rapid server exits require `restart(id)` before further requests.

Run `pnpm --filter @sortedyuan/lsp-tools test` for real TypeScript and Python tests. The package pins TypeScript 5.9.3 for the server's tsserver runtime. Run `pnpm test:integration:lsp` for Rust and Go; both commands must work on PATH. Set `MAY_LSP_TEST_IMAGE` to also run container tests with an image containing the servers, Node, Go, Rust sources and cached project dependencies. Container execution requires the coding-tools execution image prerequisites and enforces `network: "none"`.
