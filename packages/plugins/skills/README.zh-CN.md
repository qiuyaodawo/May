# @may/plugin-skills

`createSkillsPlugin({ id?, create })` 使用 `create(context)` 返回的实际 `SkillRegistry`
创建 `SkillSession`，提供 `services.skills`，并通过共享注册表贡献 `skill_read` 和动态指令。
每个 Application 分别管理激活状态。
支持 [`PluginFactoryMetadata`](../../plugin-services/README.zh-CN.md) 中带类型的
`config`、`configSchema`、依赖声明、`requiresHooks` 和 `version`。
激活状态由工厂声明和管理。

插件 setup 完成之前恢复激活文档，激活过程等待 `context.state.set()` 完成之后公开状态。
Application 保存和状态迁移使用 PluginHost；恢复已有 Session 时也读取旧的
`may.skills.active.v1` 记录。新的记录使用带版本的插件状态快照。
恢复 Session 时保留已经激活的文档内容，即使原始文件已经改变。

插件关闭时移除工具和指令贡献。SkillRegistry 是不可变的发现快照，没有资源关闭接口。

测试在被忽略的 `plugin-verification` 目录中发现、激活和恢复实际 `SKILL.md` 文件。
执行 `pnpm --filter @may/plugin-skills test`。
