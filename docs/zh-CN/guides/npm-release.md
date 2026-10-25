# 准备和验证 npm 发布

[English](../../en/guides/npm-release.md) | **简体中文**

在仓库根目录执行本文操作。环境需要 Node.js 22.16.0 或更高版本，以及
`package.json` 声明的 pnpm 版本，当前为 12.4.2。

## 发布范围

[明确的发布清单](../../../scripts/release-packages.json)包含 `@sortedyuan` 下的
39 个包：38 个库和 MaybeCode。`pnpm release:check` 检查清单与 workspace
公开包完全一致，并检查它们完整的运行时依赖均可发布。

MaybeClaw、CLI、Eval CLI、Telegram 和 Feishu 渠道插件以及示例保持私有。
增加公开包需要更新清单，并在外部项目中验证其完整依赖能够安装。

[Changesets 配置](../../../.changeset/config.json)使用 public access，关闭
自动提交以及私有包的版本更新和标签生成。0.x 期间，兼容修复使用 patch
changeset，新功能和破坏性更改使用 minor changeset。1.0 起，破坏性更改使用
major changeset。每项破坏性更改必须提供使用方迁移说明。

## 包名迁移

组件工厂和历史工具的导入更新见[公开子路径迁移指南](package-subpaths.md)。

将依赖名称、源码导入、`pnpm --filter` 选择器以及加载包模块的配置值中的
`@may/` 更新为 `@sortedyuan/`。保留包名后半部分与导出子路径，例如
`@sortedyuan/session/file-store`。重新安装依赖并编译使用方项目。
安装经过确认的新版本之前，可以执行 `pnpm remove --global @may/maybecode`
卸载旧名称的全局 MaybeCode 安装。

Plugin ID、已保存的 Session 数据、配置路径、命令名称和 Anthropic
`modelState` 格式保持原有标识。更新模块路径时保留数据中的标识。
OpenTelemetry instrumentation 使用 `@sortedyuan/observability`，需要同步更新
按 instrumentation 名称筛选的配置。

## 记录更改与准备版本

开发期间添加 changeset，说明受影响的公开包以及使用方可见的变化。
使用以下命令查看待发布更改，版本保持不变：

```sh
pnpm release:status
```

只有明确要求准备版本后，才执行 `pnpm changeset version`。随后执行
`pnpm install --lockfile-only`，检查生成的版本、内部依赖范围、changelog
和 lockfile，并重新验证。每次 Git commit 都需要明确确认。提交、推送和
发布分别取得授权。

## 验证候选版本

开发检查针对当前工作目录执行。正式发布之前，在所选发布 commit 的干净
checkout 中重复检查。查看 `git status --short`，将 `git rev-parse HEAD`
的结果与验证记录一起保存。

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm build
pnpm test
pnpm docs:check
pnpm test:package:release -- --directory ../release-package-consumers
pnpm test:package:maybecode -- --directory ../release-package-consumers
pnpm test:package:plugin
pnpm test:package:scheduler
pnpm test:package:eval
git diff --check
```

本地规则要求时，将临时文件保存在仓库内已经忽略的目录，并相应设置
`TEMP`、`TMP` 和 `TMPDIR`。离线测试中的 Git checkpoint 检查会在测试仓库
创建 commit；没有取得这些提交的授权时，设置
`MAY_GIT_CHECKPOINT_TEST_COMMITS=0`，并报告跳过的覆盖范围。浏览器、终端
和真实 Provider 检查及其环境要求见[仓库开发](repository-development.md)。

全部包检查会清理发布包的构建输出，构建并打包清单中的每个包，检查包内
文件与依赖范围，然后在仓库之外的新项目中安装 tarball。检查内容包括
公开导入、使用 `skipLibCheck: false` 检查全部 TypeScript 声明，以及安装后的
MaybeCode CLI。专项检查运行安装后的应用、插件、Scheduler 和 Eval 功能。
每项检查输出生成目录。

发布前安装通过明确的本地 tarball overrides 解析 workspace 包。正式发布
之后需要另外验证 registry 依赖解析和访问。报告实际测试的操作系统与
Node.js 版本；CI matrix 提供其他平台检查。

## 发布经过批准的版本

上传之前，取得覆盖具体包名、版本、registry 和 dist-tag 的明确授权。
确认经过批准的清单与发布清单一致，checkout 干净，并且该 commit 的
必要检查全部通过。检查 registry 登录状态时，不得输出凭据。

按照依赖顺序发布经过批准的包。单个包的命令为：

```sh
pnpm --filter <approved-package> publish --access public --registry <approved-registry> --tag <approved-tag>
```

保持 Git 检查启用。创建或推送发布标签、发布之后更改 dist-tag，以及
创建 GitHub Release，分别需要覆盖对应操作的明确授权。

命令失败后，重新尝试之前检查所选 registry 中每个经过批准的包及版本。
记录已经存在的版本，只对缺少的版本重新执行发布，并准确报告部分完成状态。

发布之后，创建没有本地 overrides 和 workspace 链接的全新外部项目。
从所选 registry 安装经过批准的精确版本，验证代表性的公开导入与
`maybecode --help`，并逐项核对 registry 版本、dist-tag 和批准清单。
保存命令结果作为发布记录。
