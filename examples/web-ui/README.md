# Offline Web UI example

Run `pnpm example:web-ui` from the repository root, then open the printed loopback URL.
This example uses the reusable Application adapter, client and Web shell without
depending on MaybeCode or MaybeClaw. Responses are scripted, storage is in memory,
and the only tool returns fixture data. No model API, filesystem or external action
is available. Messages containing `审批` exercise the approval flow.

The public fixture token is intentionally embedded only in this offline example.
Real applications require a private control token entered into the connection dialog.

## Real-host browser acceptance fixture

After `pnpm build`, run `node examples/web-ui/acceptance.mjs` from the repository root.
It starts real MaybeCode and MaybeClaw hosts at ports 3942 and 3943, backed by a
scripted model and newly created temporary data. It never loads your model config,
task queue, channels or workspace. Enter the printed public fixture token manually.

- `审批`: MaybeCode requests permission to write the temporary `fixture.txt`.
- `读取`: reads that fixture; `慢速` / `长文`: streaming and scroll checks.
- `错误`: a deliberate mock-model failure, not an external API call.
- Type `restart` in the fixture terminal to close both hosts, wait four seconds and
  reopen their persisted data. This tests reconnect without automatically resending commands.
- Type `stop` to close both hosts. Temporary data is left at the printed path for inspection.

Browser changes require a rebuild, fixture process restart, and page reload.
This fixture is for repository development only, not production deployment.

## Opt-in live model acceptance

`node examples/web-ui/live-acceptance.mjs --live` uses the configured default model
through the real provider adapter. It can incur charges. It creates synthetic
files and separate session/task stores, loads no MCP or Skills, and starts no
message channels. The shared ceiling is 12 model requests, with a 2,048-token
output limit per request and a 120-second limit per run; retries are not enabled.
Enter `public-live-acceptance-token-disposable-only` in the local connection dialog.
This public token is only for the short-lived acceptance host; stop it after use.

Inspect `acceptance-audit.json` under the printed temporary directory for request
counts and reported usage. Cancelled requests may not report usage; the audit is
not a billing statement. `fault` arms one labelled failure before the next provider
request; it does not reproduce an actual provider outage. `restart` reopens the
same data; `stop` shuts down both hosts. After a rebuild, start a new process with
`--live --resume <printed-temporary-directory>` to keep both evidence and counters.

The 2026-09-13 live browser run used the existing `gpt-5.6-luna` profile through
`openai-responses` and its configured local proxy: 9 requests, 7 completed and
2 cancelled; completed requests reported 8,992 tokens. One additional pre-request
failure was deliberately injected without contacting the provider. File edit
approval/Diff, follow-up after cancellation, task reading/cancellation, and
reloading persisted results after a process restart passed. This does not
independently verify the upstream model identity, billing, external delivery,
mobile keyboards, or crash recovery.

See the [Web UI guide](../../docs/en/guides/web-ui.md) or its
[简体中文版本](../../docs/zh-CN/guides/web-ui.md).


## Read-only state and extension gallery

After building, run `node examples/web-ui/states.mjs` and open the printed loopback
URL (port 3944). It automatically connects using a public disposable fixture token.
It contains synthetic tool states, historical approval evidence, interrupted text,
error codes, product supplements, and throwing/unsupported presentation renderers.
It has no agent, real approvals, provider, filesystem effects or recovery actions.
Type `stop` to shut it down. Use `acceptance.mjs` for real-host approval flows.
