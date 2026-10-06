# MaybeClaw

MaybeClaw connects Agent conversations to durable sessions, a Web control panel,
CLI, Telegram, and Feishu. The Gateway owns routing, access checks, approvals,
message delivery, and Agent lifecycle. May Agents use the built-in adapter;
external Agents expose declared capabilities through an adapter.

Shared functionality lives in `packages/plugins/`: delivery, Telegram, Feishu,
Agent adapters, coordination and HTTP listeners. Product composition lives in
`src/plugins/`. GatewayHost and AgentGateway own plugin hosts and release their
resources when closing. Configured Model and PermissionPolicy plugins replace
product defaults by service declaration.

可复用投递、Telegram、Feishu、Agent adapter、coordination 和 HTTP 功能位于
`packages/plugins/`，产品组合位于 `src/plugins/`。GatewayHost 和 AgentGateway
管理插件宿主及资源关闭。配置插件可以通过服务声明替换默认 Model 和
PermissionPolicy。

A session can use several Agents. Each allocated Agent conversation belongs to
one MaybeClaw session. Personal sessions bind one platform identity; group
sessions bind one group or topic. The service administrator configures session
administrators independently of platform roles.

See the [English guide](../../docs/en/guides/maybeclaw.md) or
[简体中文指南](../../docs/zh-CN/guides/maybeclaw.md) for configuration, commands,
permissions, adapters, lifecycle, and migration.

`apps.maybeclaw.persistentRules: true` enables administrator-managed permission
rules in `<data-directory>/permission-rules.json`. Eligible approvals offer
`allow-persistent`; the Web manager lists, creates and revokes rules using
verified existing scopes. Rules distinguish the initiating identity, Agent and
project. Deny rules take precedence. Save failures stop the tool before execution.
The feature is disabled by default. Custom PermissionPolicy plugins own their
scope validation and protection of rule-store files.

`apps.maybeclaw.persistentRules: true` 启用服务管理员管理的持久权限规则，保存于
`<data-directory>/permission-rules.json`。符合条件的审批提供
`allow-persistent`，Web 管理器根据已经核验的范围查看、创建和撤销规则。规则区分
发起者身份、Agent 与项目，禁止规则优先；保存失败时工具无法开始执行。缺省状态
保持关闭。自定义 PermissionPolicy 插件负责范围验证及规则存储文件保护。

```powershell
pnpm maybeclaw --help
pnpm maybeclaw
pnpm maybeclaw session create "Project review" --agent reviewer --config may.config.json
pnpm maybeclaw serve --config may.config.json --port 3939
```

`pnpm maybeclaw` starts the Web control service and opens the system default
browser. `--config`, `--port`, and `--data-directory` also work without a subcommand.
Use `--no-open` or `serve` to start only the service. Ctrl+C stops the service.

On first startup, missing configuration or missing administrator authentication opens
a local password setup page. Enter and confirm a password of 10–1024 characters.
MaybeClaw writes `version: 2`, `agents: []`, and an Argon2id `passwordHash`, preserving
existing May configuration, then serves the console at the same address. Log in and
add an Agent. Existing valid configuration starts normally; old configuration and
legacy data require explicit migration. Invalid configuration is reported without changes.

With `--no-open` or `serve`, open the local initialization HTML file printed by the
terminal. This file contains a one-time credential and is removed after initialization
or normal shutdown. Initialization accepts only the local origin. Keep the file private.

For manual configuration, retain existing `providers` and `models` and merge:

```json
{
  "apps": {
    "maybeclaw": {
      "version": 2,
      "agents": [],
      "server": { "auth": { "password": "REPLACE_WITH_YOUR_OWN_PASSWORD" } }
    }
  }
}
```

Start the Web console with `pnpm maybeclaw`, log in with the administrator password,
add your first Agent through Agent Management, and create sessions without restarting
the service. Existing `providers` and `models` remain available for May Agents.

For manual password configuration, set `apps.maybeclaw.server.auth.password`
(10–1024 characters), start `serve`, and enter that password in the Web login form.
Startup and configuration saves replace `password` with a salted Argon2id
`passwordHash`. A password change invalidates all logins. Login credentials expire
after eight hours by default and stay in page memory. Remote CLI commands use
`MAYBECLAW_ADMIN_PASSWORD` or `--password-env <name>` and log out after completion.
The Web manager organizes management actions into structured navigation groups
(Session Management, Agents & Tasks, Channels & System) with native icons. Common
operations display readable cards for task overviews, gateway settings, channels,
agents, and approvals, with collapsible diagnostic JSON sections for inspection.
Browsing sessions affects only the current page. Changing a chat entrance's
default session is an explicit operation.

`task submit` requires `--session`. Model and directory choices belong in Agent
configuration. While the server owns the data directory, use `--server` for CLI
management. Existing task data requires `migrate check` and `migrate run` before
Gateway startup. This application remains private.

`channel status --server <url>` includes migrated delivery evidence. After
checking an unknown outcome, `delivery retry-legacy <id> --confirm --server <url>`
explicitly requests another send and acknowledges possible duplicate messages.
Current messages use `delivery retry <id> --confirm --server <url>`. The Web
channel manager provides the same explicit confirmation. Remote Web access
requires a configured HTTPS `server.publicOrigin` and a reverse proxy to the
loopback listener; administrator login remains required.

Web `agent.check` includes field-level model capabilities when provided by the
adapter and offers refresh. The selected Session's diagnostic command queries
only allocated Agent conversations. May adapters share their resolver between
inspection and request validation, and propagate task correlation into Runs.
See [model and telemetry integration](../../docs/en/guides/model-telemetry-integration.md)
or [简体中文](../../docs/zh-CN/guides/model-telemetry-integration.md).
