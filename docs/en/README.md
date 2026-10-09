# May documentation

**English** | [简体中文](../zh-CN/README.md)

May provides composable packages for model/tool execution, durable conversations,
permissions, and application lifecycle. Choose a page according to your task and
experience. Public APIs and persistence formats are currently in developer preview.

## Tutorials

- [Run your first Agent application](getting-started.md): call a model, execute a
  tool, save history, and reopen a Session.

## How-to guides

### Applications and development

- [Use MaybeCode](guides/maybecode.md): start the coding Agent and use terminal controls.
- [Use MaybeClaw](guides/maybeclaw.md): configure a Gateway, Agents, sessions, and channels.
- [Develop and verify the repository](guides/repository-development.md): build, test,
  inspect CI, and select environment-specific checks.
- [Build an Agent](guides/building-an-agent.md): choose model, tools, permissions,
  Context, storage, and UI.
- [Configure and inspect MaybeCode instructions](guides/maybecode-instructions.md).
- [Use Git workspaces and checkpoints](guides/git-workspaces.md).
- [Configure the shared Web UI](guides/web-ui.md).

### Extend and operate an Agent

- [Compose plugins, services, and lifecycle Hooks](guides/plugins.md).
- [Implement a model adapter](guides/custom-model.md).
- [Implement a tool](guides/custom-tool.md).
- [Implement Context management](guides/custom-context.md).
- [Implement Session storage](guides/custom-storage.md).
- [Implement a UI](guides/custom-ui.md).
- [Configure permission policies](guides/permission-policy.md).
- [Resolve interrupted tool results](guides/recovery.md).
- [Set Run budgets](guides/run-budgets.md).
- [Use Agent Skills](guides/skills.md).
- [Manage goals](guides/goals.md).
- [Schedule time and event triggers](guides/scheduler.md).
- [Return images](guides/images.md).
- [Configure tracing](guides/observability.md).
- [Integrate model capabilities and diagnostics](guides/model-telemetry-integration.md).
- [Evaluate Agent behavior](guides/eval.md).

### Coordinate Agents

- [Build multi-agent task graphs](guides/coordination.md).
- [Configure shared resources and task workspaces](guides/coordination-resources.md).
- [Manage attempts and graph revisions](guides/coordination-lifecycle.md).
- [Connect remote leaf workers](guides/coordination-remote.md).
- [Run MaybeCode teams](guides/maybecode-team.md).
- [Delegate subagents during ordinary requests](guides/subagent-delegation.md).
- [Configure team plans](guides/maybecode-team-plan.md).
- [Read team reports and verification](guides/maybecode-team-verification.md).
- [Authorize team coding](guides/maybecode-team-coding.md).
- [Recover team execution](guides/maybecode-team-recovery.md).

### Connect MCP services

- [Connect MCP tools and host services](guides/mcp.md).
- [Configure MCP authentication](guides/mcp-auth.md).
- [Manage long-running MCP tasks](guides/mcp-tasks.md).
- [Host MCP Apps](guides/mcp-apps.md).
- [Export an MCP server](guides/mcp-server.md).

## Reference

- [Packages and public entry points](reference/packages.md).
- [Provider, model, and application configuration](reference/configuration.md).
- [Compatibility, stability, and runtime requirements](reference/compatibility.md).
- [MCP capabilities and protocol compatibility](reference/mcp-capabilities.md).

Package READMEs describe their individual exports. Import only entry points
declared in package `exports`.

## Explanations and architecture

- [Agent definitions, Application, and Workspace](concepts/agent-application.md).
- [Session, Run, and Step](concepts/session-run-step.md).
- [Context and durable history](concepts/context-and-history.md).
- [Events and durability](concepts/events.md).
- [Runtime and Session architecture](architecture/runtime-session.md).
- [Session branching and Git checkpoints](architecture/session-forks-and-checkpoints.md).
- [Plugin architecture](architecture/plugins.md).
- [Architecture decisions](architecture/decisions/README.md).

## Maintain these documents

English and Simplified Chinese pages have matching relative paths. Follow
[the documentation maintenance instructions](../AGENTS.md), update both languages,
and run `pnpm docs:check`. Check example behavior and link anchors separately.
