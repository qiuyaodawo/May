# MaybeCode

[English](README.md)

MaybeCode 是一个编程 Agent，可以读取项目、搜索文件和文本、修改代码、执行命令，
以及访问网页文档。它提供 retained 终端界面、Web UI、会话恢复和团队委派。

## 环境要求

使用 **Node.js 22.16 或更新版本**。容器执行还需要 Docker Desktop 或兼容的
Docker 运行时，并启动 Docker 服务。

## 安装

使用 npm 或 pnpm 全局安装公开发布的 package：

```sh
npm install --global @sortedyuan/maybecode
pnpm add --global @sortedyuan/maybecode
```

## 配置模型

在项目目录创建 `may.config.json`。在环境变量 `DEEPSEEK_API_KEY` 中配置
provider API key。

```json
{
  "providers": {
    "deepseek": { "adapter": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "models": {
    "deepseek": { "provider": "deepseek", "model": "deepseek-chat" }
  },
  "defaultModel": "deepseek"
}
```

## 启动

```sh
maybecode --config may.config.json .
maybecode --help
```

`--ui` 接受 `retained`（默认值）和 `web`。在终端执行 `/web`，可以打开与当前
会话连接的浏览器界面。单独启动 Web UI 需要配置 `MAYBECODE_CONTROL_TOKEN`。

## 恢复会话

```sh
maybecode --config may.config.json --continue .
maybecode --config may.config.json --resume <session-id> .
```

普通启动会创建新会话。`--continue` 恢复工作目录最近的会话，`--resume` 选择指定
会话，`/resume` 打开会话选择界面。保存的会话可以在重新启动后继续使用。

## 权限模式

默认模式自动批准 `read`、`glob` 和 `grep`。执行命令、修改文件、写入文件和
`fetch` 网页请求需要审批。`fetch` 使用单独的网络权限类别，启用持久规则后也可以
保存相应规则。

`--yolo` 开启自动批准，`--no-yolo` 使用默认模式。明确的策略拒绝仍然有效。
`/yolo on|off|status` 管理当前宿主的模式；修改模式前需要完成或取消正在执行的操作。
模式变化应用于当前宿主的全部会话和界面，重新启动后使用启动配置。

启用 `apps.maybecode.persistentRules` 后，项目的 `.may/permission-rules.json`
保存持久规则。`/permissions list`、`revoke`、`allow` 和 `deny` 管理规则。
文件编辑审批可以选择允许指定文件；规则使用项目、用户和 Agent 身份范围。
详见[权限策略](../../docs/zh-CN/guides/permission-policy.md)。

## 执行隔离

`apps.maybecode.execution` 默认使用 `{ "mode": "host" }`，命令拥有当前用户的
操作系统权限。容器模式需要提前拉取镜像，并配置相同的镜像名称：

```sh
docker pull nixery.dev/shell/git/ripgrep/util-linux
```

```json
{
  "apps": {
    "maybecode": {
      "execution": {
        "mode": "container",
        "image": "nixery.dev/shell/git/ripgrep/util-linux",
        "network": "none",
        "memoryBytes": 1073741824,
        "cpuCount": 2
      }
    }
  }
}
```

镜像必须包含 `bash`、`git`、`rg` 和 `setsid`。容器使用非 root 用户、只读根目录、
临时 `/tmp` 存储、禁用的网络，以及配置的内存和 CPU 限制。容器仅挂载工作目录。
文件工具从宿主访问同一份文件。Shell、搜索工具、子 Agent 工具和已授权的团队检查
使用配置的执行环境。MCP server 继续在宿主运行。Docker 服务不可用或镜像不存在时，
应用启动失败。关闭应用时会等待执行资源终止。

`fetch` 默认访问公网 HTTP/HTTPS origin。配置 `apps.maybecode.fetch.allowedOrigins`
后，请求仅允许访问列表中的 origin，列表可以明确开放本地服务。`maxBytes`、
`timeoutMs` 和 `maxRedirects` 限制响应。每个重定向目标都会重新检查。

## 委派通知与模型更新

自动请求和任务状态通知默认关闭。`/delegations notifications on|off|status` 管理
当前进程的通知，`apps.maybecode.delegationNotifications: true` 在启动时开启通知。
完整任务输出保存在持久记录中。

`/model` 选择模型，`/effort` 选择 reasoning effort。更新要求应用空闲，并且没有
正在运行的 Goal 或等待处理的 MCP 交互。更新保留会话历史、Goal、Skills、工作笔记
和权限模式。程序宿主通过 `controller.application.updateModel()` 更新模型。
模型插件保留模型选择的所有权。更新失败后需要成功重试才能继续提交输入。

## 会话分支与项目版本

项目默认使用 Git。已有仓库保留当前分支。首次批准修改项目的工具时，新项目会初始化
仓库。修改请求在执行工具前保存文件状态，并在完成修改、检查和委派后保存检查点。
失败或取消的请求保留未提交文件。Git 需要预先配置用户身份。

`/fork` 根据完整回复创建会话分支，可以使用当前目录或新的 worktree。
`/worktrees` 查看和管理工作目录。`/changes` 查看当前或指定请求、会话、commit
的文件变化。恢复文件需要预览和确认。

`apps.maybecode.git.autoCommit: false` 关闭自动提交，`readOnly: true` 限制项目
修改，`git: false` 关闭项目 Git 管理。存储目录需要位于项目仓库之外。
详见 [MaybeCode 指南](../../docs/zh-CN/guides/maybecode.md)。

## Web UI

`/web` 打开当前工作目录和会话的浏览器界面。终端和浏览器共享输出、审批、模型选择
和会话变化。连接链接一次有效，刷新或断开后可以重新执行 `/web`。关闭浏览器页面
保留运行中的任务；退出终端会关闭应用和 Web 服务。

单独运行 `maybecode --ui web` 时，设置 `MAYBECODE_CONTROL_TOKEN` 为长度
32 至 256 的可打印 ASCII 字符串。默认端口为 3940，可以通过 `--port` 修改。
MCP 表单和 URL 交互提供预览、明确确认以及取消操作。
详见 [Web UI 指南](../../docs/zh-CN/guides/web-ui.md)。

## Plugin 组合与产品范围

`openConfiguredMaybeCode({ plugins })` 接受自定义插件。Model、Context、Permission、
Skills、Goals、History Memory、Delegation 和 Workspace Files 组成应用功能。
MCP 和 tracing 由配置宿主管理，同一工作目录中的会话复用连接。关闭宿主会释放连接
和 tracing processor。选定插件按照服务和 identifier 替换默认提供者，并验证依赖。

MaybeCode 负责产品提示、工具装配、权限策略、修改预览、模型配置和界面命令。
May 的通用组件负责执行、取消、审批、会话历史、Context 和资源生命周期。

## 非交互团队

`maybecode team run "Inspect this module" --workspace <path>` 默认启动两个只读
worker 和一个 supervisor。`--preset supervisor|pipeline|parallel` 或 `--plan`
选择角色、模型、工具权限和依赖。团队使用独立目录、共享额度和持久任务记录。

执行状态与验收状态分别记录。配置的检查产生 `passed`、`failed` 或 `unverified`
验收结果。`--mode coding` 开放明确列出的修改工具，`--allow-checks` 单独授权
配置中的检查命令。检查继承 `apps.maybecode.execution`。`team diff` 导出补丁，
`team apply --confirm <digest>` 在用户审阅后应用补丁。

`team status`、`resume`、`cancel`、`retry` 和 `reconcile` 管理状态与恢复。
详见[团队指南](../../docs/zh-CN/guides/maybecode-team.md)、
[验收](../../docs/zh-CN/guides/maybecode-team-verification.md)、
[编程任务](../../docs/zh-CN/guides/maybecode-team-coding.md)和
[恢复](../../docs/zh-CN/guides/maybecode-team-recovery.md)。

## 自定义界面与程序调用

自定义界面通过 `MaybeCodeController` 提交操作，读取事件，并通过
`controller.application` 访问当前会话的应用。切换会话后重新读取该字段。
以下示例使用已经配置的模型；在支持 TypeScript 的运行环境中执行：

```ts
import { openConfiguredMaybeCode, type MaybeCodeController } from "@sortedyuan/maybecode";

const controller: MaybeCodeController = await openConfiguredMaybeCode({
  configPath: "may.config.json",
});
const observation = (async () => {
  for await (const event of controller.events) {
    console.log(event);
  }
})();

try {
  console.log(controller.application.modelInfo);
  await (
    await controller.submit({ input: "Inspect this workspace." })
  ).result;
} finally {
  await controller.close();
  await observation;
}
```

控制器支持提交、steering、取消、审批、会话管理、历史以及 Context 管理。
执行期间普通输入会取消当前操作并等待终止，然后开始新输入；`/steer` 在当前 Step
完成后接收额外输入。`/stop` 取消当前操作和等待中的输入。

retained 界面支持鼠标滚动、文本选择、剪贴板和终端 Markdown。`Ctrl+G` 后按 `D`
切换工具详情，按 `T` 切换 reasoning 显示，按 `R` 定位当前请求的完整回复。
`Tab` 切换到会话内容，方向键和 PageUp/PageDown 浏览内容。编辑区方向键管理输入
历史，`Ctrl+J` 插入换行，`Enter` 提交。`MAY_TUI_LEADER` 和 `MAY_CLIPBOARD`
配置快捷键与剪贴板行为。

## 运行配置

支持 `deepseek-chat`、`zhipu-chat`、`kimi-chat`、`anthropic-messages`、
`openai-responses` 和 `openai-chat-completions` adapter。模型的
`contextWindowTokens` 和 `maxOutputTokens` 提供 Context 预算信息。

交互模式默认对暂时性模型请求错误最多尝试三次；`apps.maybecode.retry` 配置次数
和等待时间，`false` 关闭重试。Team 模式分别计算每次 provider 请求。

`apps.maybecode.observability` 配置不含内容的 JSONL tracing，默认关闭。
文件名称包含本地日期，默认保留 60 天。关闭工作目录后刷新并关闭 processor。

`apps.maybecode.mcpServers` 配置宿主 stdio 或 Streamable HTTP server。
`/mcp` 查看连接与工具，`refresh` 更新目录，`reconnect` 重新连接。
环境变量引用必须在启动时存在。OAuth 登录使用 `maybecode mcp login`。
资源、prompt、采样和长期任务的权限与生命周期见
[MCP 指南](../../docs/zh-CN/guides/mcp.md)。

## 指令

`apps.maybecode.instructionsDirectory` 指定包含非空 UTF-8 `system.md` 的目录，
相对路径以配置文件目录为起点。它替换内置系统提示。
项目规则从项目根目录到工作目录逐层读取，每层优先使用 `AGENTS.override.md`，
其次使用 `AGENTS.md`。每个文件以及合计内容分别受 32 KiB 限制。
应用打开、接受输入和每次 Run 前刷新项目规则。`/instructions` 查看有效内容。
详见[指令组合](../../docs/zh-CN/guides/maybecode-instructions.md)。

## 命令、Context 与存储

`/new` 创建会话，`/resume` 管理历史会话，`/model` 和 `/effort` 管理模型，
`/retry` 继续失败请求，`/status` 和 `/context` 查看状态，`/help` 查看命令。
`/skills` 管理 Skills。`/goal start|status|pause|resume|cancel` 管理持久目标。
`/recovery` 查看需要用户验证结果的中断工具记录。

自动 Context 管理提供 `prune-summary`、`history-reference` 和 `provider-native`
三种模式。历史引用模式使用持久工作笔记和历史检索，provider-native 要求模型支持。
Context 变化写入会话记录，恢复会话时重新使用。`context_notes` 保存当前会话笔记，
`get_context_remaining` 提供用量估计。详见
[Context 管理](../../docs/zh-CN/guides/maybecode.md)。

会话记录和目录默认保存在 `~/.may/maybecode`，内容为明文，每个会话需要单个活动
写入者。文件修改提供有界 diff 预览，并记录版本化展示事件以支持会话恢复。

## 测试

```sh
pnpm --filter @sortedyuan/maybecode test
pnpm test:package:maybecode
```

打包检查安装完整依赖到独立消费者目录，编译两个 README 中的 TypeScript 示例，
执行安装后的 `maybecode --help`，并验证 Web UI 启动。开发环境使用仓库声明的
pnpm 版本。外部依赖优先使用缓存，并按需从 registry 下载。

`pnpm test:integration:maybecode` 使用用户配置进行真实 DeepSeek 请求。
持久权限集成测试需要明确启用 `MAYBECODE_PERSISTENT_RULES_LIVE=1`，使用实际
provider 创建独立文件并验证规则复用。详情见 [English README](README.md#tests)。
