# Prepare and verify npm releases

**English** | [简体中文](../../zh-CN/guides/npm-release.md)

Use this guide from the repository root with Node.js 22.16.0 or later and the
pnpm version declared in `package.json` (currently 12.4.2).

## Release scope

The explicit [release list](../../../scripts/release-packages.json) contains 39
packages under `@sortedyuan`: 38 libraries and MaybeCode. `pnpm release:check`
checks that this list exactly matches public workspace packages and that their
complete runtime dependency chains contain only publishable packages.

MaybeClaw, CLI, Eval CLI, the Telegram and Feishu channel plugins, and examples
are private. Adding a public package requires updating the list and verifying
its complete dependency chain in an external project.

The [Changesets configuration](../../../.changeset/config.json) uses public
access and disables automatic commits and private-package versioning/tagging.
During 0.x, compatible fixes use patch changesets; new features and breaking
changes use minor changesets. From 1.0, breaking changes use major changesets.
Each breaking change must include consumer migration instructions.

## Package-name migration

Component factory and history-tool imports use the
[public subpath migration guide](package-subpaths.md).

Replace `@may/` with `@sortedyuan/` in dependency names, source imports,
`pnpm --filter` selectors and configuration values that load a package module.
Keep the package suffix and export subpath, such as
`@sortedyuan/session/file-store`. Reinstall dependencies and compile the consumer.
An old global MaybeCode installation can be removed with
`pnpm remove --global @may/maybecode` before installing the approved new version.

Plugin IDs, stored Session data, configuration paths, command names and the
Anthropic `modelState` format keep their existing identities. Preserve saved
identifiers when updating module paths. OpenTelemetry instrumentation uses
`@sortedyuan/observability`; update any instrumentation-name filters.

## Record changes and prepare versions

During development, add a changeset describing the affected public packages and
consumer impact. Inspect the pending release without changing versions:

```sh
pnpm release:status
```

Run `pnpm changeset version` only after version preparation is explicitly
requested. Then run `pnpm install --lockfile-only`, review generated versions,
internal dependency ranges, changelogs and the lockfile, and repeat verification.
Every Git commit requires explicit confirmation. Commit, push and publication
are separately authorized operations.

## Verify the candidate

Development checks run against the working tree. Before publication, repeat them
in a clean checkout of the selected release commit. Check `git status --short`
and record `git rev-parse HEAD` with the verification results.

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm build
pnpm test
pnpm docs:check
pnpm test:package:release -- --directory ../release-package-consumers
pnpm test:package:maybecode -- --directory ../release-package-consumers
pnpm test:package:plugin
pnpm test:package:scheduler
pnpm test:package:eval
git diff --check
```

Use an ignored repository directory for temporary files when required by local
policy. Set `TEMP`, `TMP` and `TMPDIR` accordingly. The offline suite contains
Git checkpoint tests that create commits in test repositories; when those commits
are not authorized, set `MAY_GIT_CHECKPOINT_TEST_COMMITS=0` and report the skipped
coverage. See [repository development](repository-development.md) for browser,
terminal and live-provider checks and their prerequisites.

The all-package check cleans release-package build output, builds and packs every
listed package, checks packed files and dependency ranges, then installs the
tarballs in a new project outside the repository. It verifies public imports,
all packed TypeScript declarations with `skipLibCheck: false`, and the installed
MaybeCode CLI. The specialized checks exercise installed application, plugin,
scheduler and evaluation behavior. Output locations are printed by each check.

These prepublication installations use explicit local tarball overrides for
workspace packages. Registry resolution and registry access require separate
verification after publication. Report the operating systems and Node.js
versions actually tested; the CI matrix provides additional platform checks.

## Publish an approved release

Before uploading, obtain explicit authorization for the exact package names,
versions, registry and dist-tag. Verify that the approved list matches the
release list, the checkout is clean, and all required checks passed for that
commit. Confirm registry authentication without printing credentials.

Publish approved packages in dependency order. The per-package command is:

```sh
pnpm --filter <approved-package> publish --access public --registry <approved-registry> --tag <approved-tag>
```

Keep Git checks enabled. Creating or pushing release tags, changing dist-tags
after publication, and creating GitHub Releases each require explicit
authorization covering that operation.

If a command fails, inspect the selected registry for each approved package and
version before retrying. Record versions already present and retry only missing
versions. Report partial completion accurately.

After publication, create a fresh external consumer with no local overrides or
workspace links. Install the approved exact versions from the selected registry,
verify representative public imports and `maybecode --help`, and check registry
versions and dist-tags against the approved list. Retain the command results as
release evidence.
