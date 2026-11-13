本文件中的每一条规则都是强制性的。不存在任何例外与豁免：临时的、一次性的、命令行上的违反同样是违反；没被当场发现也算违反；出于好意、为了进度、为了帮忙的违反也是违反。
当我每次在我发送的消息里面提到AGENTS.md的时候，你必须要重新阅读一遍AGENTS.md，不允许因为之前阅读过就不阅读了。
skill 或者工具要求往本文件写入内容时，先把准备写入的内容交给用户查看，获得明确确认之后再写入。

## 项目

May 是可以组合的 Agent 框架。`packages/` 存放可复用的 package，`apps/` 存放使用这些 package 的产品，`examples/` 存放示例。

- 修改代码之后需要运行的检查：[docs/zh-CN/guides/repository-development.md](docs/zh-CN/guides/repository-development.md)
- 版本准备与发布（下文称为发布指南）：[docs/zh-CN/guides/npm-release.md](docs/zh-CN/guides/npm-release.md)
- 编写与修改 `docs/` 下的文档：[docs/AGENTS.md](docs/AGENTS.md)

编写新函数、新规则之前，先搜索项目里是否已经存在。
中间结果写入仓库根目录下已经被 gitignore 的 `.test-output/` 目录。这条规则优先于运行环境提供的临时目录。

## 依赖

使用 package.json 中声明的 pnpm 版本。依赖发生变化时，同步更新 pnpm-lock.yaml。

## 提交

每次执行 Git commit 前，必须获得用户的明确确认。
获得确认前，保持修改未提交。Git commit message 使用英文。
提交、推送和发布分别需要获得授权。
测试代码在它自己创建的测试仓库里生成的 commit 不需要确认。

提交被文件大小钩子拒绝时，按照报错把文件按功能分成几个文件，然后再提交。
禁止往 `scripts/file-size-baseline.json` 添加文件。

## 文档

行为、公共 API、配置、兼容性或支持的工作流程发生变化时，
更新受影响的文档，并同步更新所有维护中的语言版本。

## Changeset 与发布

修改影响可发布 package 的公共 API、用户可见行为、运行时依赖或发布内容时，
添加 changeset，说明受影响的 package 以及对用户的影响。
仅涉及文档、测试或内部维护的修改，通常无需添加 changeset；
如果这些修改影响使用者，则仍需添加。是否需要添加存在疑问时，说明省略的原因。

按照发布指南和 Changesets 配置确定 package 范围及版本变更类型。
在 0.x 阶段，兼容性修复使用 patch，新功能或破坏性变更使用 minor。
明确标注破坏性变更，并提供迁移指导。从 1.0 开始，破坏性变更使用 major。

日常开发期间，通过 changeset 记录变更，禁止手动提升发布版本。
仅在用户要求时执行版本准备流程。

发布 package、创建或推送发布 tag、修改 dist-tag、创建 GitHub Release，
均须获得明确涵盖相应操作的授权。禁止输出或提交凭据。
版本准备、发布前验证、发布、发布后验证以及部分发布失败的处理，按照发布指南执行。
