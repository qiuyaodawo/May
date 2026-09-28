# Personal assistant

**English** | [简体中文](../../zh-CN/guides/personal-assistant.md)

`apps/personal-assistant` is a complete product built from May packages. It keeps
a Markdown personal database, works a Gmail mailbox, prepares 南京大学 ehall
transactions in a real browser, and serves the same session to a phone through the
shared Web workbench. It is the reference answer to the course exercise
"a personal assistant that grows".

```bash
pnpm assistant serve          # 启动助手与手机工作台
pnpm assistant status         # 查看数据目录、数据库与邮箱状态
pnpm assistant ask "这封通知需要哪些材料"
```

## The five capabilities and where they live

| Capability | Implementation | Safety boundary |
| --- | --- | --- |
| Personal database | `src/vault/`, `src/tools/vault-tools.ts` | Files are the only source of truth; the index is a rebuildable cache; writes stay inside the vault |
| Continuous mailbox | `src/mail/`, `src/tools/mail-tools.ts` | Messages are registered once by Message-ID; only the confirmed draft version can be sent |
| ehall transactions | `src/ehall/`, `src/tools/ehall-tools.ts` | Filling never submits; submission needs a matching field digest; irreversible services are denied |
| Phone control | `src/server/`, `src/web-panel.ts` | The service owns the run; the control token is the only credential; loopback by default |
| Shared context and growth | `src/growth/`, `src/agent.ts` | Corrections become rules in every new session; successful flows become editable skills |

## Personal database

The vault is a Git repository of Markdown files. `Vault` indexes it with MiniSearch
over heading-based chunks, so a search hit carries the file path and the exact line
range:

- `vault_search` returns `path`, `lines` and a snippet;
- `vault_read` returns numbered lines for citation;
- `vault_write` requires the previous `hash` when overwriting an existing file.

The index is stored under `.index/` and is ignored by Git. Every read operation
reconciles the index with the files first, so a file edited in Obsidian is searchable
on the next call. Search tokenization emits Latin words plus CJK unigrams and
bigrams, which keeps Chinese recall usable without a segmentation dictionary.

The default layout is created on first run:

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

## Mailbox

`Mailbox` connects over IMAP (`imapflow`) and sends over SMTP (`nodemailer`).
`MailLedger` is a durable JSON state machine keyed by Message-ID:

```text
new ──mail_draft_create──▶ drafted ──用户确认──▶ confirmed ──mail_send──▶ sent ──▶ archived
```

- A repeated check only returns messages that are not in the ledger, so the same
  mail is never drafted or sent twice.
- The draft body lives in `mail/drafts/<id>.md`; the ledger stores a SHA-256 digest
  of `to`, `cc`, `subject` and `body`.
- `mail_draft_create` and `mail_draft_update` are available to the model.
  **Confirming a draft is not**: only the Web panel or the CLI can confirm, and any
  later content change invalidates the confirmation.
- `mail_send` refuses unless the confirmed digest equals the current digest, and it
  returns the previous result for an already sent draft.
- The poller in `PersonalAssistant` checks the mailbox on an interval and submits a
  notification run when new mail appears. It never sends anything by itself.

Gmail needs an app password:

```bash
export MAY_ASSISTANT_MAIL_PASSWORD="app-password"
```

## ehall

`EhallService` drives a real Chromium through Playwright with a persistent profile,
so one interactive login is reused. The agent sees the page the way a person does:
`ehall_page` returns the accessibility tree and `ehall_controls` lists fillable
fields with their accessible names. Values come from the vault.

`ehall_review` reads the live form and produces a digest over the URL, the service
id, the submit button and every field value. That digest is the unit of consent:

1. the assistant shows the field table and explains what the submit button does;
2. the user confirms that exact digest from the phone or the CLI;
3. `ehall_submit` re-reads the form, refuses when anything changed, then clicks;
4. the field table is archived under `ehall/forms/` and committed to Git.

Services marked `irreversible: true` in `ehall/services.md` — course withdrawal and
application withdrawal are the built-in examples — are denied by the permission
policy and refused again by the tool. The assistant prepares materials and fills the
form, and the user submits those by hand.

The catalog is ordinary Markdown frontmatter. Adding a transaction is one entry:

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

## Phone and Web

`may-assistant serve` starts the assistant, the mail poller and an authenticated
HTTP service. The page is the shared `@may/web-ui` workbench plus a product panel
(`src/web-panel.ts`) that lists drafts, edits their body, confirms a version, shows
the current ehall field table and confirms it. Closing a page never stops a run: the
service owns the session.

The service binds `127.0.0.1` and prints a login URL with a one-time ticket, the
same exchange `@may/ui-client/server` uses. For phone access:

```bash
may-assistant serve --host 192.168.1.20 --allow-lan
```

`--allow-lan` refuses to run on loopback and prints the LAN URL. The control token
is the only credential, so keep the service on a trusted network and do not publish
it.

## Growth

Two mechanisms keep corrections and successful flows:

- `rule_learn` writes `vault/rules/<date>-<slug>.md`. `openAssistantApplication`
  reads every rule at session open and puts them in the system prompt, so
  "报名截止时间不是活动开始时间" applies to the next unrelated notice in a new
  session.
- `skill_learn` writes `vault/skills/<name>/SKILL.md`. `SkillRegistry` discovers the
  vault skills directory, and the model activates one with `skill_read`.

The built-in `notice-to-apply` skill describes the full cross-tool flow: read the
notice, collect materials from the vault, fill the ehall form, draft the reply,
submit and archive. Edit it in place when the flow changes.

## Configuration

Non-secret settings live in `~/.may/config.json`; secrets stay in the environment.

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

| Environment variable | Purpose |
| --- | --- |
| `MAY_ASSISTANT_CONTROL_TOKEN` | Workbench control token, 32–256 printable characters; generated and printed when unset |
| `MAY_ASSISTANT_MAIL_PASSWORD` | IMAP/SMTP password (Gmail app password) |
| `MAY_ASSISTANT_HOME` | Default data directory when `home` is not configured |

Unknown keys are rejected instead of ignored, so a typo fails at startup.

## Checks

```bash
pnpm --filter @may/personal-assistant test           # 离线测试，不访问外部服务
pnpm --filter @may/personal-assistant exec playwright install chromium
pnpm --filter @may/personal-assistant test:browser   # 真实 Chromium + 本地固定页面
pnpm --filter @may/personal-assistant test:integration:mail   # 需要真实邮箱凭据
```

The offline suite uses a scripted `Model` and a real Chromium for the browser check
against a local fixture page; it never contacts ehall, Gmail or a model provider.
The live mailbox check is skipped unless `MAY_ASSISTANT_LIVE_IMAP_*` and
`MAY_ASSISTANT_LIVE_SMTP_*` are set, and it only sends to the account itself.

## Known limits

- IMAP fetching and the send path are covered by the live check, not by the offline
  suite; the offline suite proves the ledger, digest and confirmation rules.
- ehall field names come from the live page. The built-in catalog is a starting
  point: correct `submitLabel` and the material list from the page you actually see.
- The LAN mode has no transport encryption of its own. Use a trusted network or a
  private tunnel that terminates TLS in front of the service.
- One process owns one browser profile, one mailbox ledger and one vault, matching the
  single-writer file storage the packages document.
