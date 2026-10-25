# Migrate component imports to public subpaths

**English** | [简体中文](../../zh-CN/guides/package-subpaths.md)

Use this guide when upgrading an application or plugin that imports one of the
six packages in the table. This is a breaking package-path change. The current
workspace provides the subpaths below; registry consumers need published versions
containing those exports. Check the destination package's changelog before upgrading.

| Previous package | Public import path | Install dependency |
| --- | --- | --- |
| `@sortedyuan/plugin-models` | `@sortedyuan/plugin-services/models` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-runtime` | `@sortedyuan/plugin-services/runtime` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-permissions` | `@sortedyuan/plugin-services/permissions` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-skills` | `@sortedyuan/plugin-services/skills` | `@sortedyuan/plugin-services` |
| `@sortedyuan/plugin-coordination` | `@sortedyuan/coordination/plugin` | `@sortedyuan/coordination` |
| `@sortedyuan/session-tools` | `@sortedyuan/session/tools` | `@sortedyuan/session` |

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
import { createModelPlugin } from "@sortedyuan/plugin-services/models";
import { createSessionHistoryTool } from "@sortedyuan/session/tools";

const plugin = createModelPlugin({ create: () => model });
const historyTool = createSessionHistoryTool({ source: session });
```

The `plugin-services` root exports service tokens, registries and factory metadata.
Import component factories through their subpaths. Plugins retain independent IDs,
configuration, activation and replacement behavior. Function names, ServiceToken IDs,
plugin IDs and saved state formats remain unchanged. Existing Session and Skill state
requires no data conversion; retain any explicit plugin IDs in application configuration.

The [release list](../../../scripts/release-packages.json) contains 39 packages.
The six previous packages are outside that list. Repository verification includes
`pnpm release:check`, `pnpm test:package:release` with an external directory, and
`pnpm test:package:plugin`, which installs tarballs outside the repository and runs
the public-subpath tests. See [release verification](npm-release.md) for commands.
