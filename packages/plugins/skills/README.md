# @may/plugin-skills

`createSkillsPlugin({ id?, create })` creates a `SkillSession` from the real
`SkillRegistry` returned by `create(context)`. It provides `services.skills` and
contributes the `skill_read` tool and dynamic instructions through the shared
registries. Each Application has an independent activation state.
Typed `config`, `configSchema`, dependency declarations, `requiresHooks`, and
`version` follow [`PluginFactoryMetadata`](../../plugin-services/README.md).
The factory owns its activation state declaration.

Activated documents are restored before setup completes. Activations await
`context.state.set()` before becoming visible, so Application persistence and state
migration use the plugin host. Application also reads legacy `may.skills.active.v1`
Session records when resuming existing data. New records use the versioned plugin
state snapshot. Activating a skill retains its saved content across resume even
when the original file changes.

Closing the plugin removes its tool and instruction contributions. The registry is
an immutable discovery snapshot with no resource disposal API.

Tests discover, activate and restore actual `SKILL.md` files in the ignored
`plugin-verification` directory: `pnpm --filter @may/plugin-skills test`.
