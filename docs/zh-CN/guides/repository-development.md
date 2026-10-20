# 开发和验证仓库

[English](../../en/guides/repository-development.md) | **简体中文**

修改 May 源码、文档或工作目录依赖时使用本指南。在仓库根目录执行命令，使用
Node.js 22.16.0 或更新版本，以及 `package.json` 声明的 pnpm 版本，当前为 12.4.2。
`.node-version` 推荐 Node.js 24；离线测试使用 `node:sqlite` backup API。

## 安装与构建

```bash
pnpm install --frozen-lockfile
pnpm build
```

安装使用 lockfile 中的依赖版本。本地存储缺少依赖时需要访问 registry。明确修改
依赖时使用 `pnpm install`，并检查 lockfile 的变化。

根目录构建会检查类型并编译工作目录，随后使用 esbuild 打包 MaybeCode CLI。
`pnpm --filter @sortedyuan/maybecode build` 同样生成 CLI 打包文件。
`dist/bin.js` 必须与 `dist/cli/` 中的文件一起使用。package 的 library exports
继续使用 TypeScript 编译的模块。CLI 根据选中的命令加载对应功能，图片编码模块和
Web 服务资源在使用时加载。

## 选择相关检查

- `pnpm docs:check`：检查双语文件配对、语言链接、本地目标文件和代码围栏配对。
  锚点、表达及示例需要另外检查。
- `pnpm --filter <package-name> test`：检查一个 package，使用其 `package.json` 中
  的名称替换参数。
- `pnpm test`：执行工作目录中的离线测试，继续检查各个 package 后报告失败；
  package 测试全部通过后执行文件锁检查。
- `pnpm test:locks`：在 `pnpm build` 后运行，通过实际 package 与应用 API 检查
  锁所有权、进程终止、初始化失败和释放。Windows 还通过 PowerShell 与 Windows
  文件 API 控制待删除状态，验证竞争时序。测试数据位于忽略的
  `review/file-lock-matrix/`；Team patch 检查结束后清理临时来源目录对应的应用锁文件。
- `pnpm test:coverage`：执行各个 package 提供的覆盖率检查。
- `pnpm test:path-alias`：通过 Windows junction 或 POSIX symlink 使用临时目录，
  检查代码对规范路径的假设。
- `pnpm test:package:maybecode`、`pnpm test:package:plugin` 和
  `pnpm test:package:eval`：在仓库外检查打包后的 package。

核查退出状态并阅读失败信息。文档检查不会执行示例；package 测试无法单独证明
真实 Provider 的兼容性。

执行 `pnpm test:package:maybecode` 时，设置 `MAY_GIT_CHECKPOINT_TEST_COMMITS=0`
可以验证关闭自动 Git 提交的启动过程。默认打包检查配置启用自动 Git 提交。

## 持续集成

[CI 工作流](../../../.github/workflows/ci.yml) 在推送和 PR 时运行，也支持通过
**Actions → CI → Run workflow** 手动启动。检查环境包括 Linux 的 Node.js 22 和
24，以及 Windows、macOS 的 Node.js 24。

每种环境安装固定版本依赖、构建并执行一遍离线测试。手动启动时，Windows 使用
路径别名测试。Linux 的 Node.js 24 另外检查文档、WebUI 资源同步、MCP Apps 浏览器
隔离、基础示例，以及 May、MaybeClaw 和 Eval CLI 帮助。浏览器检查安装无头 Chromium。

独立的 Linux 和 Windows 任务使用 `.node-version`，检查打包后的 MaybeCode、插件
宿主和评估 package。工作目录 package 使用本地 tarball；外部依赖使用 pnpm 存储
或 registry。MaybeCode 检查在隔离的用户目录中配置 Git 身份，用于初始项目 checkpoint。

通过 Actions 或 PR 检查查看任务日志，定位失败位置。环境列表说明检查目标；支持
声明需要成功运行的依据。CI 无需 Provider API key，也不会发布 package。

## 需要额外环境的检查

真实 Provider 检查使用相应 `test:integration` 命令和已经配置的凭据。例如，
MaybeClaw 需要 `MAYBECLAW_LIVE_MODEL` 及 Provider 凭据：

```bash
pnpm --filter @sortedyuan/maybeclaw test:integration
```

系统剪贴板检查需要 Windows 桌面会话：

```powershell
powershell -NoProfile -STA -File scripts/test-terminal-clipboard.ps1
```

真实终端的输入、快捷键和窗口大小变化需要终端验证，并记录使用环境和执行项目。
单个 Session 的工具、Skills、压缩和重试测试设置 `subagents: false`；取消检查也
覆盖默认委派流程。真实 Provider 与桌面检查独立于 CI 的离线测试。
