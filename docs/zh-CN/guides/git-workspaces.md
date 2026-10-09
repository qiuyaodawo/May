# Git 工作区与文件检查点

[English](../../en/guides/git-workspaces.md) | **简体中文**

`@may/application/git-workspace` 提供 Node.js 组件 `ProjectGitWorkspace`，
要求 `PATH` 中存在 Git 2.36 或更新版本。应用提供工作区和提交授权策略；组件提供仓库识别、
持久化文件版本、diff、恢复预览和登记的 worktree 管理。

宿主需要将完整用户请求与文件版本及 Session 分支关联时，可以使用本文的步骤。
要求应用已经管理 Session id，并按顺序处理工作区操作。

## 准备工作区

1. 确认 Git 可用，宿主具有可信的提交审批方法。
2. 根据宿主工作流程选择 `autoCommit` 和 `readOnly`。
3. 打开组件，为 Session 准备初始文件版本。

启用自动管理时，`prepare()` 可以提交已有修改。宿主必须通过 `authorizeCommit`
取得要求的用户授权。下面的集成片段中，`sessionId` 为应用身份，
`confirmProjectCommit` 为宿主实际的审批函数：

```ts
import { ProjectGitWorkspace } from "@may/application/git-workspace";

const files = await ProjectGitWorkspace.open({
  workspace: process.cwd(),
  authorizeCommit: request => confirmProjectCommit(request),
});
await files.prepare(sessionId);
```

`open()` 识别所属仓库，包括仓库子目录中的项目和已有 Git worktree。
自动管理开启时，没有 Git 的项目会初始化仓库。`prepare()` 保存初始未提交修改，
支持 index 与工作文件内容相同的已有 staged 修改。Git 使用项目已有的作者身份、
Hooks、忽略规则、attributes 和签名配置，组件保留这些配置。身份、签名或 Hook
失败会终止准备过程。

`autoCommit` 默认为 `true`。`autoCommit: false` 读取已有版本并保留未提交修改。
`readOnly: true` 保留现有仓库和文件状态，不创建版本或状态文件。宿主通过 `status()`
处理尚未使用 Git 的只读工作区。Git 的 `GIT_CEILING_DIRECTORIES` 仓库查找边界继续生效。

提交范围为所属仓库。`excludedPaths` 接受仓库内的绝对路径或相对于仓库根目录的路径。
Git 忽略的文件保持排除。自动管理排除 `.env`、`.env.*`，保留 `.env.example`；
也排除 `credentials.json`、常见私钥文件、`secrets.json`、`secrets.yaml`、
`secrets.yml` 和 `.pem`、`.p12`、`.pfx`、`.key` 文件。
已被 staged 的排除文件会触发明确错误。应用需要为项目自定义凭据文件配置额外排除项。
staged 与工作文件内容不同、未解决冲突、进行中的 merge/rebase 或历史操作、
子模块和发生变化的嵌套仓库，都需要处理完成后才能自动提交。

## 完成一次请求

接受请求的文件修改之前调用 `beginRound()`，在工作和验证结束之前保留返回的 lease。
以下片段要求宿主实现 `processCompleteUserRequest()` 和 `associateCheckpoint()`：

```ts
const lease = await files.beginRound({ sessionId });
try {
  const result = await processCompleteUserRequest();
  const checkpoint = await lease.complete({
    outcome: "completed",
    runId: result.runId,
    runIds: result.runIds,
    historyPosition: result.historyPosition,
    commitMessage: "Update project configuration",
  });
  await associateCheckpoint(checkpoint);
} finally {
  await lease.close();
}
```

lease 覆盖一次完整用户请求中的文件修改与检查，通过文件互斥保护当前仓库工作目录，
支持跨进程保护。独立 worktree 使用独立的互斥文件。Session 的首次处理会根据需要
准备初始版本。`complete()` 释放互斥文件，`close()` 可以重复调用。
宿主调用 `complete({ outcome: "failed" })` 或
`complete({ outcome: "cancelled" })`，记录未完成状态并保留修改。
MaybeCode 的失败和取消 checkpoint 关联该请求的全部主 Run 身份，并以最后一个主 Run
作为 `runId`，因此最后一条回复仍然可以读取本次请求的文件变化。
MaybeCode Goal Run 在宿主验证期间保留 lease。可选 `finalize(outcome)` 回调在
Goal 完成验证后保存最终文件版本和宿主确认的 Session 位置；验证失败或取消时保留
未提交修改并释放 lease。Run 结果可以先于回调结束，让 Goal Controller 继续验证。

成功处理至多创建一个 commit，提交说明使用英文。没有符合范围的修改时关联当前 commit。
checkpoint 保存开始与结束 commit、branch、工作区、Session、请求中的 Run 身份、
可选历史位置，以及 `committed`、`unchanged`、`uncommitted` 或 `failed` 状态。
`GitCheckpointError.checkpoint` 描述失败操作；已经创建的 commit 会在能够读取时记录。
提交之后再次检查符合范围的 staged 与工作文件修改。Hook 编辑或期间发生的其他写入
产生失败的部分 checkpoint，保留已经创建的 commit 和剩余文件修改。

`checkpoints(sessionId?)`、`checkpoint(id)` 和
`checkpointByRun(sessionId, runId)` 读取已保存记录。
`bindCheckpoint(id, historyPosition)` 在文件版本保存之后关联 Session 的最终历史位置。
`status()` 返回当前 branch、detached HEAD、尚无 commit 的仓库和未提交修改。
历史 checkpoint 中的 branch 记录保持当时内容。
状态和 diff 读取使用独立的 Git client，项目 Hook 或签名进程处理 commit 期间继续支持读取。

状态记录默认保存在 `~/.may/git-workspaces/<projectId>/`。状态目录和可配置的
worktree 目录都要求位于来源仓库之外。保存的版本和比较起点分别具有
`refs/may/checkpoints/` 与 `refs/may/checkpoint-starts/` 引用保护。
关闭或删除 Session 保留这些引用和项目 commit，没有自动过期清理。

提交之前保存准备好的 Git tree，提交之后保存已创建 commit 的持久化操作记录。
重新打开时能够恢复已完成的 commit，保持一次处理的提交数量。
期间 Git 历史发生无法确认的变化时，明确报告需要检查的状态。
互斥文件所属进程终止后支持恢复；活动进程、其他主机和身份无效的记录继续受到保护。

## 比较和恢复文件

恢复文件时，宿主按顺序执行：

1. 选择检查点和明确的文件范围。
2. 调用 `previewRestore()`，展示当前内容和目标内容。
3. 取得要求的恢复授权。
4. 调用 `restore(preview)`，报告结果检查点或部分失败。

`diff({ from, to?, file? })` 比较两个 commit；省略 `to` 时比较当前工作文件。
结果包含 unified diff、每文件状态和 patch、rename 来源路径、二进制标记、
行数统计和未追踪文件。生成 diff 时排除已配置的凭据路径。

`previewRestore({ checkpointId, paths })` 要求明确选择文件，返回已审阅的当前内容
指纹与目标内容。`restore(preview)` 在修改之前验证所有指纹，写入期间逐个再次检查路径。
支持常规文件，拒绝通过父目录 symbolic link 访问文件和修改 Git 元数据。
恢复读取 Git 对象，通过常规文件写入和删除完成操作，二进制文件保留原始内容。
期间发生编辑时终止恢复并报告冲突。宿主需要展示预览，并取得要求的授权后调用恢复。
`GitWorkspaceConflictError` 提供可以展示的状态冲突说明，覆盖恢复指纹变化、
工作区被其他 writer 使用，以及受到保护的 worktree 删除操作。

`restore(preview, { sessionId, runId?, historyPosition?, commitMessage? })`
在相同文件互斥保护期间恢复选定文件并保存结果 checkpoint。
文件操作失败可能导致部分恢复完成；宿主需要报告失败并保留预览供检查。

## 管理 worktree

`createWorktree({ sessionId, historyPosition, checkpointId })` 使用选定 checkpoint
对应的 commit 创建独立 Git branch 和 worktree。
默认目录为 `~/.may/worktrees/<projectId>/<worktreeId>`，通过 `worktreesRoot` 配置。
子目录项目在新 worktree 中使用相同的项目相对目录。
返回记录包含来源 Session 与位置、commit、路径、branch、关联 Session/进程和生命周期状态。
部分创建失败时保留登记记录和诊断。

`listWorktrees()` 返回 May 登记的 worktree。
`attachWorktreeSession(id, sessionId, attached?)` 和
`trackWorktreeProcess(id, pid, attached?)` 管理生命周期关联。
`failWorktree(id, error)` 记录 application 或 Session 关联失败，保留新目录和 branch。

`deleteWorktree(id)` 检查登记信息、目录身份、所属 Git 仓库、关联 Session、
登记的运行进程、已追踪/未追踪/忽略文件、branch 身份，以及尚未包含在来源工作区中的 commit。
目录没有需要保留的内容和关联对象时，删除 worktree 及已经合并的 branch。
Git 历史比较使用登记时的来源工作区，支持从其他关联 worktree 发起管理操作。
失败登记中的目录和 Git branch 均未创建时，也支持移除记录。
关闭 Session 保留 worktree；删除 Session 与删除 worktree 由宿主分别操作。

MaybeCode 根据选定 worktree 重新创建工具和 Skills。配置的 MCP stdio 工作目录
位于项目内部时使用对应目录，项目外部的绝对目录保留配置值。各个工作区分别管理
连接，返回原工作区时复用连接。MCP host roots 表示当前工作区。关闭 MaybeCode
宿主时释放全部工作区连接。
资源订阅关联所属工作区和 Session。其他工作区使用相同 server ID 与资源 URI 时，
创建独立的订阅；订阅通知仅发送给当前所属的会话。

MaybeCode 将分支准备、worktree 变更、文件恢复和会话切换标记为活动工作区操作。
操作完成之前拒绝新输入和其他状态变更，覆盖 Git Hooks 与签名等待期间。
关闭宿主时等待已经接受的工作区操作完成，随后关闭应用和所属资源。
文件恢复失败时保留预览供检查，并报告 Git checkpoint 保存失败。

## 验证集成

确认 `status()` 返回选定目录及当前仓库状态，完成请求具有检查点，
`diff()` 描述该请求的文件变化。验证失败和取消时修改得到保留。
通过明确预览验证文件恢复，并检查 worktree 的生命周期关联。

取得独立测试仓库内的 Git 提交授权后，运行真实 Git 集成验证：

```powershell
$env:MAY_GIT_CHECKPOINT_TEST_COMMITS = '1'
pnpm --filter @may/application build
node --test packages/application/test/git-workspace*.test.mjs
```

测试目录保存在被忽略的 `review/git-workspace-tests/` 下。每个可写测试目录都初始化
并核对自己的仓库身份，随后配置测试作者信息。测试操作限定在独立仓库内。

独立 package consumer 验证会打包完整 runtime 依赖，通过 tarball 离线安装，
并运行发布内容中的 Git subpath：

```powershell
$env:MAY_GIT_PACKAGE_TEST = '1'
$env:MAY_GIT_CHECKPOINT_TEST_COMMITS = '1'
pnpm --filter @may/application test:package
```
