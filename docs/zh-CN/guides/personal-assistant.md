# 个人助手

[English](../../en/guides/personal-assistant.md) | **简体中文**

`apps/personal-assistant` 是一个用 May 各 package 组合出来的完整产品：维护一个
Markdown 个人数据库，持续处理 Gmail 邮箱，用真实浏览器准备南京大学办事大厅的
事务，并把同一个会话通过共享的 Web 工作台交给手机使用。它是课程实验
「会成长的个人助手」的参考实现。

```bash
pnpm assistant serve          # 启动助手与手机工作台
pnpm assistant status         # 查看数据目录、数据库与邮箱状态
pnpm assistant ask "这封通知需要哪些材料"
```

## 五项能力与代码位置

| 能力 | 实现 | 安全边界 |
| --- | --- | --- |
| 个人数据库 | `src/vault/`、`src/tools/vault-tools.ts` | 文件是唯一事实来源，索引只是可重建的缓存，写入不越出库目录 |
| 持续关联邮箱 | `src/mail/`、`src/tools/mail-tools.ts` | 邮件按 Message-ID 只登记一次，只有被确认的那一版草稿可以发送 |
| 办理 ehall 事务 | `src/ehall/`、`src/tools/ehall-tools.ts` | 填写不等于提交，提交需要字段摘要一致，不可撤销事务直接拒绝 |
| 手机端联动 | `src/server/`、`src/web-panel.ts` | 任务由服务持有，控制令牌是唯一凭证，默认只监听回环地址 |
| 能力组合与成长 | `src/growth/`、`src/agent.ts` | 纠正变成每次新会话都会加载的规则，跑通的流程变成可修改的技能 |

## 个人数据库

个人数据库是一个 Markdown 文件的 Git 仓库。`Vault` 用 MiniSearch 按标题分块建立
索引，因此检索结果带着文件路径和准确的行号区间：

- `vault_search` 返回 `path`、`lines` 和片段；
- `vault_read` 返回带行号的原文，用于引用；
- `vault_write` 覆盖已有文件时必须提供上一次的 `hash`。

索引保存在 `.index/`，不进 Git。每次读取之前都会先与文件对齐，因此在 Obsidian
里改过的文件，下一次检索就能搜到。分词对拉丁字母按词切分，对中文同时产出单字与
相邻二字组合，不依赖分词词典也能保持可用的召回。

首次运行会创建下面的目录结构：

```text
vault/
  people/            联系人、导师、本人信息
  records/           证件、成绩单用途、照片位置
  projects/          每个事项的进展、截止时间与待办
  mail/drafts/       待发送草稿（正文就是草稿文件）
  mail/sent/         已发送邮件归档
  mail/inbox/        收件归档
  ehall/services.md  办事事务目录（frontmatter 里是事务列表）
  ehall/forms/       提交前后的字段表
  rules/             用户纠正后的规则
  skills/            沉淀下来的技能
```

## 邮箱

`Mailbox` 通过 IMAP（`imapflow`）收取邮件，通过 SMTP（`nodemailer`）发送。
`MailLedger` 是一个按 Message-ID 索引的持久化状态机：

```text
new ──mail_draft_create──▶ drafted ──用户确认──▶ confirmed ──mail_send──▶ sent ──▶ archived
```

- 重复检查只返回账本里没有的邮件，同一封邮件不会被起草两次、发送两次。
- 草稿正文保存在 `mail/drafts/<id>.md`，账本保存 `to`、`cc`、主题与正文的
  SHA-256 摘要。
- 模型可以使用 `mail_draft_create` 与 `mail_draft_update`，**没有确认草稿的工具**：
  确认只能由网页面板或命令行完成，内容一旦改动，旧确认立即失效。
- `mail_send` 在确认摘要与当前摘要不一致时拒绝发送；已经发送过的草稿直接返回
  已有记录。
- `PersonalAssistant` 里的定时检查只负责收取新邮件并提交一次通知任务，本身不会
  发送任何内容。

Gmail 需要使用应用专用密码：

```bash
export MAY_ASSISTANT_MAIL_PASSWORD="app-password"
```

## 办事大厅

`EhallService` 通过 Playwright 驱动一个真实的 Chromium，使用持久化用户目录，
登录一次之后可以一直复用。助手像人一样看页面：`ehall_page` 返回无障碍结构，
`ehall_controls` 列出可填写字段及其可及名称，填写内容全部来自个人数据库。

`ehall_review` 读取当前表单，并对地址、事务编号、提交按钮和每个字段的值计算摘要。
这个摘要就是授权的单位：

1. 助手展示字段表，说明点击哪个按钮会发生什么；
2. 用户在手机或命令行确认这一版摘要；
3. `ehall_submit` 重新读取表单，只要有任何变化就拒绝，然后才点击提交；
4. 字段表归档到 `ehall/forms/` 并提交 Git。

`ehall/services.md` 中标记 `irreversible: true` 的事务（内置的退课申请与撤销申请
就是例子）会被权限策略拒绝，工具本身也会再拒绝一次。助手只准备材料并填写表单，
提交由本人完成。

办事目录就是普通的 Markdown frontmatter，增加一个事务只需要加一条：

```yaml
- id: dorm-repair
  name: 宿舍报修
  category: 后勤
  url: https://ehall.nju.edu.cn/fw/hq/fw/index.do
  irreversible: false
  submitLabel: 提交
  materials:
    - path: people/self.md
      note: 宿舍楼与房间号
```

## 手机与网页

`may-assistant serve` 会启动助手、邮箱定时检查和一个带认证的 HTTP 服务。页面是
共享的 `@may/web-ui` 工作台，加上本产品自己的面板（`src/web-panel.ts`）：列出
草稿、修改正文、确认某一版、展示当前办事表单字段并确认。关掉页面不会中断任务，
会话由服务持有。

服务默认监听 `127.0.0.1`，并打印带一次性票据的连接链接，使用的就是
`@may/ui-client/server` 的票据交换。手机访问时：

```bash
may-assistant serve --host 192.168.1.20 --allow-lan
```

`--allow-lan` 不允许配合回环地址使用，并会打印局域网地址。控制令牌是唯一凭证，
请只在可信网络里使用，不要把服务暴露到公网。

## 成长

纠正与成功流程分别由两个机制保存：

- `rule_learn` 写入 `vault/rules/<日期>-<标题>.md`。`openAssistantApplication`
  在打开会话时读取全部规则并放进系统提示，因此「报名截止时间不是活动开始时间」
  在下一个不相关的通知里同样生效。
- `skill_learn` 写入 `vault/skills/<名称>/SKILL.md`。`SkillRegistry` 会发现个人
  数据库里的技能目录，模型用 `skill_read` 激活并按其中的步骤执行。

内置的 `notice-to-apply` 技能描述了完整的跨工具流程：读通知、从个人数据库收集
材料、填写办事表单、起草回复、提交并归档。流程变化时直接修改这个文件即可。

## 配置

非机密设置写在 `~/.may/config.json`，机密只放在环境变量里。

```json
{
  "apps": {
    "personal-assistant": {
      "home": "~/.personal-assistant",
      "mail": {
        "host": "imap.gmail.com",
        "port": 993,
        "secure": true,
        "user": "me@gmail.com",
        "address": "me@gmail.com",
        "sentMailbox": "[Gmail]/Sent Mail"
      },
      "ehall": { "headless": false, "timeoutMs": 30000 },
      "server": { "port": 3946 },
      "poll": { "enabled": true, "intervalMinutes": 15 }
    }
  }
}
```

| 环境变量 | 用途 |
| --- | --- |
| `MAY_ASSISTANT_CONTROL_TOKEN` | 工作台控制令牌，32 到 256 个可见字符；没有设置时生成并打印 |
| `MAY_ASSISTANT_MAIL_PASSWORD` | IMAP/SMTP 口令（Gmail 使用应用专用密码） |
| `MAY_ASSISTANT_HOME` | 没有配置 `home` 时使用的数据目录 |

不认识的配置项会直接报错而不是被忽略，拼写错误在启动时就会暴露。

## 检查命令

```bash
pnpm --filter @may/personal-assistant test           # 离线测试，不访问外部服务
pnpm --filter @may/personal-assistant exec playwright install chromium
pnpm --filter @may/personal-assistant test:browser   # 真实 Chromium + 本地固定页面
pnpm --filter @may/personal-assistant test:integration:mail   # 需要真实邮箱凭据
```

离线测试使用固定脚本的 `Model`，浏览器检查使用真实 Chromium 访问本地固定页面，
不会访问 ehall、Gmail 或任何模型服务。真实邮箱检查在没有设置
`MAY_ASSISTANT_LIVE_IMAP_*` 与 `MAY_ASSISTANT_LIVE_SMTP_*` 时跳过，并且只发给自己。

## 已知限制

- 收取邮件与发送链路由真实邮箱检查覆盖，离线测试覆盖的是账本、摘要与确认规则。
- ehall 的字段名来自真实页面。内置目录只是起点，`submitLabel` 与材料清单需要按
  实际页面校正。
- 局域网模式本身不提供传输加密，请使用可信网络，或在服务前面加一层终止 TLS 的
  私有通道。
- 一个进程持有一个浏览器用户目录、一个邮箱账本和一个个人数据库，与各 package
  文档中单写入者的文件存储假设一致。
