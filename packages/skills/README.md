# `@may/skills`

Reusable Agent Skills support for any May agent. `SkillRegistry.discover(roots)`
parses SKILL.md frontmatter and exposes immutable metadata, diagnostics,
revision-checked `load(name)` and bounded `readResource(name, path)`.
Later roots override earlier names. Invalid skills are skipped with diagnostics.

`SkillSession` manages deduplicated activation, provides `skill_read`,
`instructions()`, a persistence sink and snapshot restoration. Scripts never
execute automatically and `allowed-tools` never grants permissions.
Pass `skills: registry` to `defineAgent()` or `AgentApplication.open()` to compose
this with durable state and dynamic Context instructions.

See the [English guide](../../docs/en/guides/skills.md) and
[中文指南](../../docs/zh-CN/guides/skills.md) for paths, commands and integration.
