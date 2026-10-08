---
"@may/skills": patch
"@may/plugin-skills": patch
"@may/plugin-delegation": minor
"@may/coordination": patch
---

Skills 初始提供名称、描述及兼容要求，通过 `skill_read` 按需读取正文与资源；
保留已激活文档的 Session 持久化行为，并明确指令贡献顺序。

委派工具描述提供任务说明和等待流程，动态指令提供共享 workspace、角色和请求限制，
仅在委派工具可用时注入。子 Agent 指令提供文件范围及报告要求。

新增基础与项目指令来源、运行前刷新及权限模式 callbacks，使子 Session 按顺序接收
自己的运行环境、项目规则与任务说明。
