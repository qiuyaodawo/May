# MaybeCode 提示词组装

[English](../../en/guides/maybecode-instructions.md)

基础提示词提供 MaybeCode 身份、代码任务职责、交付内容及完成条件，以及信息处理和
交流要求。`instructionsDirectory/system.md` 或显式 `instructions` 可以替换本次应用的
基础提示词。

## 来源与顺序

| 顺序 | 来源 | 提供条件 |
| --- | --- | --- |
| -100 | 基础提示词 | 每次请求 |
| -80 | 当前运行环境 | 每次请求 |
| -60 | workspace 根目录 `AGENTS.md` 及其绝对来源路径 | 文件存在时 |
| -40 | 工具使用指导 | 每次请求 |
| 0 | Skills 元数据及已激活文档 | Skills 可用时 |
| 20 | 协作指导或子任务说明 | 委派可用时，或者当前属于子 Agent |
| 40 | Goal 目标、进度及执行指导 | Goal 正在执行时 |
| 60 | 上下文管理指导 | history-reference 模式 |

`InstructionSources` 根据 `order`、插件组装顺序和注册顺序排列贡献内容。插件自行
注册需要提供的指导。工具描述和参数 schema 通过模型请求的工具定义提供。

## 环境与项目内容更新

运行环境包括 workspace 绝对路径、操作系统、实际 shell、Agent 角色、会话来源及
当前权限模式。shell 名称出现一次，语法指导位于环境字段之后。历史会话分支可以提供
来源 Session。子 Agent 环境提供所分配的角色、父任务，并根据自己的工具提供 shell 信息。

应用打开、接受用户输入和 Run 开始时读取项目规则。运行期间接受 steering 输入时
同样刷新，后续 Context snapshot 使用更新的内容。子 Session 使用共同的项目来源
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
