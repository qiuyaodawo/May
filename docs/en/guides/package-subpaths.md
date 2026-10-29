# Migrate component imports to public subpaths

**English** | [简体中文](../../zh-CN/guides/package-subpaths.md)

Use this guide when upgrading an application or plugin that imports the component
packages in the table. This is a breaking package-path change. The current
workspace provides the subpaths below; registry consumers need published versions
containing those exports. Check the destination package's changelog before upgrading.

| Previous package | Public import path | Install dependency |
| --- | --- | --- |
| `@sortedyuan/application` | `@sortedyuan/may` or `@sortedyuan/may/application` | `@sortedyuan/may` |
| `@sortedyuan/core` | `@sortedyuan/may/core` | `@sortedyuan/may` |
| `@sortedyuan/context` | `@sortedyuan/may/context` | `@sortedyuan/may` |
| `@sortedyuan/session` | `@sortedyuan/may/session` | `@sortedyuan/may` |
| `@sortedyuan/permissions` | `@sortedyuan/may/permissions` | `@sortedyuan/may` |
| `@sortedyuan/config` | `@sortedyuan/may/config` | `@sortedyuan/may` |
| `@sortedyuan/skills` | `@sortedyuan/may/skills` | `@sortedyuan/may` |
| `@sortedyuan/file-storage` | `@sortedyuan/may/storage` | `@sortedyuan/may` |
| `@sortedyuan/plugin` | `@sortedyuan/may/plugin` | `@sortedyuan/may` |
| `@sortedyuan/plugin-services` | `@sortedyuan/may/services` | `@sortedyuan/may` |
| `@sortedyuan/goal` | `@sortedyuan/may/goals` | `@sortedyuan/may` |
| `@sortedyuan/plugin-goals` | `@sortedyuan/may/goals/plugin` | `@sortedyuan/may` |
| `@sortedyuan/plugin-history-memory` | `@sortedyuan/may/history-memory` | `@sortedyuan/may` |
| `@sortedyuan/provider-<protocol>` | `@sortedyuan/providers/<protocol>` | `@sortedyuan/providers` |
| `@sortedyuan/plugin-delegation` | `@sortedyuan/coordination/delegation` | `@sortedyuan/coordination` |
| `@sortedyuan/plugin-mcp` | `@sortedyuan/mcp/plugin` | `@sortedyuan/mcp` |
| `@sortedyuan/plugin-observability` | `@sortedyuan/observability/plugin` | `@sortedyuan/observability` |
| `@sortedyuan/plugin-agent-adapters` | `@sortedyuan/gateway/adapters` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-agent-adapters/rpc` | `@sortedyuan/gateway/rpc` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-delivery` | `@sortedyuan/gateway/delivery` | `@sortedyuan/gateway` |
| `@sortedyuan/plugin-web-api` | `@sortedyuan/gateway/web-api` | `@sortedyuan/gateway` |
| `@sortedyuan/keybindings` | `@sortedyuan/tui/keybindings` | `@sortedyuan/tui` |
| `@sortedyuan/plugin-models` | `@sortedyuan/may/services/models` | `@sortedyuan/may` |
| `@sortedyuan/plugin-runtime` | `@sortedyuan/may/services/runtime` | `@sortedyuan/may` |
| `@sortedyuan/plugin-permissions` | `@sortedyuan/may/services/permissions` | `@sortedyuan/may` |
| `@sortedyuan/plugin-skills` | `@sortedyuan/may/services/skills` | `@sortedyuan/may` |
| `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
| `@sortedyuan/session-tools` | `@sortedyuan/may/session/tools` | `@sortedyuan/may` |

Preserve existing suffixes for Application, Session, Context, permissions and
configuration exports, for example `@sortedyuan/may/application/git-workspace`,
`@sortedyuan/may/session/file-store`, and `@sortedyuan/may/config/schema`.
The `plugin-services/models`, `runtime`, `permissions` and `skills` suffixes become
`may/services/models`, `runtime`, `permissions` and `skills`. Provider protocols are
`openai`, `openai-compatible`, `anthropic`, `gemini`, `deepseek`, `kimi` and `zhipu`.
The OpenAI-compatible HTTP helpers use `@sortedyuan/providers/openai-compatible/http`.
The RPC example uses `@sortedyuan/gateway/examples/rpc-file-agent`.

1. Replace the previous dependencies in `package.json` with the destination packages,
   selecting versions that include these exports. Subpaths belong in imports;
   dependency keys use the package names from the final column.
2. Update source imports, reexports, module-resolution calls, and configured module
   specifiers. Plugin factories still return `PluginDefinition` objects; a configured
   plugin module must export such an object.
3. Reinstall dependencies and update the consuming project's lockfile. Rebuild the
   application and any plugin packages that import these APIs.
4. Verify plugin activation, resource cleanup and resumed Session state in the
   consuming application. The [plugin guide](plugins.md) describes these lifecycles.

For example, an application supplies its actual Model as `model` and its open
Session as `session` when using these snippets:

```ts
import { createModelPlugin } from "@sortedyuan/may/services/models";
import { createSessionHistoryTool } from "@sortedyuan/may/session/tools";

const plugin = createModelPlugin({ create: () => model });
const historyTool = createSessionHistoryTool({ source: session });
```

The `@sortedyuan/may/services` entry exports service tokens, registries and factory metadata.
Import component factories through their subpaths. Plugins retain independent IDs,
configuration, activation and replacement behavior. Function names, ServiceToken IDs,
plugin IDs and saved state formats remain unchanged. Existing Session and Skill state
requires no data conversion; retain any explicit plugin IDs in application configuration.

The [release list](../../../scripts/release-packages.json) contains 14 packages.
Telegram and Feishu channels are internal modules of MaybeClaw. Repository verification includes
`pnpm release:check`, `pnpm test:package:release` with an external directory, and
`pnpm test:package:plugin`, which installs tarballs outside the repository and runs
the public-subpath tests. See [release verification](npm-release.md) for commands.
