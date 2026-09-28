# Personal assistant

A complete May product: a Markdown personal database, a continuous Gmail mailbox,
南京大学 ehall transactions in a real browser, and a phone workbench served from the
same long-running process. Corrections and successful flows are saved as rules and
skills, so the assistant gets better across sessions.

The full guide, including the safety boundaries and the configuration reference, is
[docs/en/guides/personal-assistant.md](../../docs/en/guides/personal-assistant.md)
with a
[简体中文](../../docs/zh-CN/guides/personal-assistant.md) mirror.

## Run

```bash
pnpm build
node apps/personal-assistant/dist/bin.js serve
```

The command prints a loopback URL with a one-time login ticket. Open it on the
desktop or on a phone on the same network. Management commands work without the
model:

```bash
node apps/personal-assistant/dist/bin.js status
node apps/personal-assistant/dist/bin.js index
node apps/personal-assistant/dist/bin.js rules
node apps/personal-assistant/dist/bin.js mail drafts
node apps/personal-assistant/dist/bin.js mail confirm <draftId>
node apps/personal-assistant/dist/bin.js ehall services
node apps/personal-assistant/dist/bin.js ehall review <serviceId>
```

## Configuration

Non-secret settings live in `~/.may/config.json` under `apps["personal-assistant"]`;
`MAY_ASSISTANT_MAIL_PASSWORD` and `MAY_ASSISTANT_CONTROL_TOKEN` stay in the
environment. Unknown keys are rejected at startup.

## Tests

```bash
pnpm --filter @may/personal-assistant test
pnpm --filter @may/personal-assistant exec playwright install chromium
pnpm --filter @may/personal-assistant test:browser
```

The offline suite uses a scripted model and never contacts a provider, Gmail or
ehall. The browser check drives a real Chromium against a local fixture page. The
live mailbox check in `test/integration` is skipped unless `MAY_ASSISTANT_LIVE_IMAP_*`
and `MAY_ASSISTANT_LIVE_SMTP_*` are set.
