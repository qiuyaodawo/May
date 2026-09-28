---
"@may/personal-assistant": minor
---

新增 `apps/personal-assistant`：一个用 May 组合出来的完整个人助手应用，位于
`apps/personal-assistant`，不对外发布。

它把五项能力放在同一次会话里：

- 个人数据库：`~/.personal-assistant/vault` 是 Markdown 文件的 Git 仓库，
  `vault_search` 按标题分块检索并返回文件路径与行号区间，索引随文件变化更新。
- 持续关联邮箱：IMAP 收取、SMTP 发送，邮件按 Message-ID 只登记一次；
  草稿正文存在个人数据库里，账本保存内容摘要，只有被用户确认的那一版可以发送，
  模型没有确认草稿的工具。
- 办理 ehall 事务：Playwright 驱动真实 Chromium，按可及名称填写字段；
  提交前展示字段表并生成字段摘要，用户确认后才会提交，字段变化即失效；
  退课、撤销申请等不可撤销事务被权限策略与工具双重拒绝。
- 手机端联动：`may-assistant serve` 提供带一次性票据的 Web 工作台，并附带草稿
  编辑、确认与办事表单确认面板；任务由服务持有，关掉页面不会中断。
- 能力组合与成长：`rule_learn` 记录的用户纠正会进入之后每个会话的系统提示，
  `skill_learn` 把跑通的流程写成可修改的技能，内置 `notice-to-apply` 技能描述
  通知到提交的完整流程。

`packages` 下的组件与已有的应用没有改动。
