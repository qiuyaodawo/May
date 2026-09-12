# MaybeClaw

MaybeClaw is a local, single-user durable-task assistant built on May. This
developer preview provides a foreground CLI, persistent queue, long-running local
server, Web UI, and allowlisted Feishu/Telegram private chats. It does not depend
on MaybeCode. It is not an automatically installed OS service.

See the [English guide](../../docs/en/guides/maybeclaw.md) or
[简体中文指南](../../docs/zh-CN/guides/maybeclaw.md) for commands, recovery,
permissions, storage, configuration and the implementation boundary.

```powershell
pnpm maybeclaw --help
pnpm maybeclaw task submit "Explain the supplied requirements" --request-id requirements-1
$env:MAYBECLAW_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# Paste this token into the local Web UI; do not put it in a URL or config file.
pnpm maybeclaw serve
```

Use `--enqueue` to persist without starting a model in that CLI process; an active
server consumes queued tasks. Without `--read-directory`,
the agent has no file tools. Granting a directory permits its text to be sent to
the configured model provider; choose a small directory without secrets.

The root entry exports `MaybeClaw`, `FileTaskStore`, task types, configuration
helpers, `MaybeClawHost`, `startControlServer`, channel adapters and `runMaybeClaw`.
They are product-owned developer-preview contracts,
not a new stable `@may/tasks` framework API.
