---
"@may/plugin": minor
"@may/application": minor
"@may/plugin-services": minor
"@may/plugin-runtime": minor
"@may/plugin-models": minor
"@may/plugin-permissions": minor
"@may/plugin-skills": minor
"@may/plugin-goals": minor
"@may/plugin-history-memory": minor
"@may/plugin-delegation": minor
"@may/plugin-mcp": minor
"@may/plugin-observability": minor
"@may/plugin-delivery": minor
"@may/plugin-channel-telegram": minor
"@may/plugin-channel-feishu": minor
"@may/plugin-agent-adapters": minor
"@may/plugin-coordination": minor
"@may/plugin-web-api": minor
---

Expose existing Agent functionality as reusable plugins with declared services,
dependencies and managed resource lifecycles. Add shared typed service tokens and
ordered tool, instruction, Model and Context contribution registries. Application
direct options compose through plugin factories, and replacement services receive
creation notifications for the active Application.

Add plugin factories for runtime, Model, permissions, Skills, goals, historical
Context, delegation, MCP, observability, durable delivery, Telegram, Feishu, Agent
adapters, task coordination and HTTP listeners. MaybeCode and MaybeClaw use these
factories for their application and workspace lifecycles. Existing direct APIs and
application exports remain available. Configuration-selected providers replace
product defaults by declared service or plugin identity.
MCP commands, events and delegated Agent tools use the active service provider;
Application-owned pools follow Session lifecycles and configured shared pools
follow the workspace lifecycle.

PluginContext exposes pluginOrder for deterministic contribution ordering.
Model plugins may provide modelInfo for metadata and model presentation; configured
applications derive Context budgets from the selected Model service.
Breaking change: reserved `may.model.provider`, `may.model.name`,
`may.model.adapter` and `may.model.profile` trace attributes are populated only
from the active `modelInfo` service. Supply `createModelPlugin({ create, info })`
to record these fields. Other caller-defined trace attributes remain supported.
Lifecycle notifications reach Session plugins and their ancestor handlers.
Adapter release removes cached instances; coordination release relinquishes
runtime resources. HTTP shutdown drains requests and closes connections before
disposing product services. Packaged consumers can install each public plugin's
complete runtime dependency chain independently of the repository.
The public RPC file Agent example serializes state reads and writes, supports
concurrent steering and cancellation, and preserves saved inputs after restart.

Skills state is saved through versioned plugin state while existing Session
activation records remain readable. Goals and history-memory retain their existing
durable state records for migration. Applications remain private.
