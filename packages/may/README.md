# `@sortedyuan/may`

**English** | [简体中文](README.zh-CN.md)

Composable Agent definitions, execution, conversations, permissions and plugins.

Use `defineAgent()` from the root entry to configure an Agent and open an
application with a Session store. Each application owns its Session lifecycle.

| Entry | Purpose |
| --- | --- |
| `@sortedyuan/may` | Agent definitions, Application and Workspace |
| `@sortedyuan/may/core` | Model/tool loop, interfaces, events and budgets |
| `@sortedyuan/may/context` | Model-visible context and compaction |
| `@sortedyuan/may/session` | Conversation history, recovery and branches |
| `@sortedyuan/may/session/file-store` | JSONL Session storage |
| `@sortedyuan/may/session/catalog` | Session discovery |
| `@sortedyuan/may/storage` | File access and writer ownership |
| `@sortedyuan/may/permissions` | Tool policy and approval handling |
| `@sortedyuan/may/plugin` | Scoped services and Hooks |
| `@sortedyuan/may/services` | Agent service definitions and registries |
| `@sortedyuan/may/config` | Configuration loading and validation |
| `@sortedyuan/may/skills` | Skill discovery and activation |
| `@sortedyuan/may/goals` | Durable goal execution |
| `@sortedyuan/may/goals/plugin` | Goal plugin |
| `@sortedyuan/may/history-memory` | History reference memory and compaction plugin |
| `@sortedyuan/may/application/git-workspace` | Git workspace lifecycle |

Node.js 22.16.0 or newer is required. File storage and Git integrations use Node
APIs. The Core entry can be imported independently of these integrations.

See the [Agent guide](../../docs/en/guides/building-an-agent.md) and
[package reference](../../docs/en/reference/packages.md).

Module references cover [Application](docs/application/README.md),
[Core](docs/core/README.md), [Context](docs/context/README.md),
[Session](docs/session/README.md), [storage](docs/storage/README.md),
[permissions](docs/permissions/README.md), [plugins](docs/plugin/README.md),
[services](docs/services/README.md), [configuration](docs/config/README.md),
[Skills](docs/skills/README.md), [goals](docs/goals/README.md),
[goal integration](docs/goals-plugin/README.md), and
[history memory](docs/history-memory/README.md).
