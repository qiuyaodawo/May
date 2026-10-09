# 配置与查看 MaybeCode 指令

[English](../../en/guides/maybecode-instructions.md) | **简体中文**

基础提示词提供 MaybeCode 身份、代码任务职责、交付内容及完成条件，以及信息处理和
交流要求。`instructionsDirectory/system.md` 或显式 `instructions` 可以替换本次应用的
基础提示词。

## 配置项目与基础指令

前提：已有配置完成的 [MaybeCode 工作区](maybecode.md)，并具有项目指令文件的
编辑权限。

1. 在项目根目录的 `AGENTS.md` 编写共享规则。目录专属规则写在对应子目录；
   MaybeCode 从该目录或更深目录启动时，规则参与发现。
2. 需要替换同一目录的规则时，在该目录创建非空 `AGENTS.override.md`。每个目录
   只选择一份文件。
3. 需要替换基础提示词时，将 `apps.maybecode.instructionsDirectory` 指向包含
   `system.md` 的目录。相对路径根据配置文件所在目录解析。公共库调用方可以
   直接提供 `instructions`。
4. 修改基础提示词后重新打开应用。项目规则在接收输入和 Run 启动时刷新。
5. 执行 `/instructions`，检查来源路径与顺序，确认选中文档适用于工作区，并且
   每份文档只出现一次。

显示内容包含当前指令贡献。Goal 继续执行提醒在模型请求准备时单独提供。
字段说明见[配置参考](../reference/configuration.md#maybecode-设置)。

## 来源与顺序

| 顺序 | 来源 | 提供条件 |
| --- | --- | --- |
| -100 | 基础提示词 | 每次请求 |
| -80 | 当前运行环境 | 每次请求 |
| -60 | 项目根目录至 workspace 的项目规则及其绝对来源路径 | 文件存在时 |
| -40 | 工具使用指导 | 每次请求 |
| 0 | Skills 元数据及已激活文档 | Skills 可用时 |
| 20 | 协作指导或子任务说明 | 委派可用时，或者当前属于子 Agent |
| 40 | Goal 目标、进度及执行指导 | Goal 正在执行时 |
| 60 | 上下文管理指导 | history-reference 模式 |

`InstructionSources` 根据 `order`、插件组装顺序和注册顺序排列贡献内容。插件自行
注册需要提供的指导。工具描述和参数 schema 通过模型请求的工具定义提供。

## 项目规则发现

workspace 是应用启动时指定的目录。MaybeCode 向上寻找最近的 `.git` 文件或目录，
然后依次检查从该项目根目录到 workspace 的各级目录。worktree 的 `.git` 文件同样
可以标识项目根目录。找不到标记时，只检查 workspace。发现过程不会扫描兄弟目录、
workspace 的子目录，或者最近项目根目录之上的目录。

每个目录最多提供一份非空规则文件，依次检查 `AGENTS.override.md` 和 `AGENTS.md`。
不存在的文件和空文件会被跳过。选中的文档按照父目录到子目录的顺序进入项目规则
提示词，每份文档保留绝对 `Source` 路径。多份文档还会提供目录适用范围，并说明存在
冲突时更深目录规则优先。父目录规则继续在其适用范围内有效。

例如，在 `repo/packages/web` 启动应用，且 `repo` 存在 `.git` 标记时，可以加载
`repo/AGENTS.md`、`repo/packages/AGENTS.md` 和 `repo/packages/web/AGENTS.md`。
非空的 `repo/packages/web/AGENTS.override.md` 优先于同目录的 `AGENTS.md`。
在 `repo` 启动时，只检查项目根目录。

每份文档和组合后的项目规则正文各有 32 KiB 限制，正文之间的空行计入总大小。
无效 UTF-8、超出大小限制，以及不安全的 symbolic links、reparse points 或 hard links
会使加载失败。读取祖先目录的规则不会改变代码工具使用的 workspace 或权限策略。

使用 `@may/coding-tools/instructions` 的宿主可以配置 `projectRootMarkers`
（默认 `[".git"]`）、`projectInstructionsFilename`（默认 `AGENTS.md`）和
`projectInstructionsFallbackFilenames`（默认 `[]`）。`projectRootMarkers: []`
只检查 workspace。`projectInstructionsFilename: false` 禁用完整项目规则链。
`CodingInstructions.projects` 按顺序提供所有选中文档；`project` 保留距离 workspace
最近的选中文档。完整内容通过 `projects` 或 `effective` 获取，也可以调用
`formatCodingProjectInstructions(projects, label?)` 单独生成项目规则提示词。
这些配置属于公共加载器；MaybeCode 使用默认值。

## 环境与项目内容更新

运行环境包括 workspace 绝对路径、操作系统、实际 shell、Agent 角色、会话来源及
当前权限模式。shell 名称出现一次，语法指导位于环境字段之后。历史会话分支可以提供
来源 Session。子 Agent 环境提供所分配的角色、父任务，并根据自己的工具提供 shell 信息。

应用打开、接受用户输入和 Run 开始时重新发现完整项目规则链。运行期间接受 steering
输入时同样刷新，后续 Context snapshot 使用更新的内容。子 Session 使用共同的项目来源
和刷新函数，其任务说明独立提供。选定的基础提示词在重新打开应用时更新。

提示词贡献内容变化时，使此前的 provider token 计量失效。MaybeCode 在重新创建
Runtime 时清除此前的计量，使用当前 Context 估计值，直到 provider 提供新的 usage。

## 按条件提供的指导

Skills 元数据包括名称、描述及兼容要求。模型通过 `skill_read` 激活完整文档，或者
按需要读取引用资源。已激活文档继续保存在所属 Session 的提示词中。

委派工具描述独立任务的提交和结果接收方式。补充指导提供共享 workspace 要求、角色
和执行限制。子 Agent 提示词提供文件分工及报告要求。

Goal 插件提供当前目标状态。简短继续执行提醒计入 Context 用量，并放在实际模型请求
的最后位置。history-reference 模式提供笔记保存与上下文重置指导，重置后提供已保存
的工作状态。

`/instructions` 显示当前提示词贡献内容。Goal 的最后位置提醒在模型请求准备时提供。
