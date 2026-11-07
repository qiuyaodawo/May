# Develop and verify the repository

**English** | [简体中文](../../zh-CN/guides/repository-development.md)

Use this guide when changing May source, documentation, or workspace dependencies.
Run commands from the repository root with Node.js 22.16.0 or newer and the pnpm
version declared in `package.json` (currently 12.4.2). Node.js 24 is recommended
in `.node-version`; the offline suite uses `node:sqlite` backup APIs.

## Install and build

```bash
pnpm install --frozen-lockfile
pnpm build
```

Installation uses the locked dependency versions and needs registry access for
packages missing from the local store. When intentionally changing dependencies,
use `pnpm install` and review the resulting lockfile changes.

The root build type-checks and compiles the workspace, bundles the MaybeCode
CLI with esbuild, and writes each application's composed configuration schema to
`apps/<application>/dist/<application>-config.schema.json`. `pnpm --filter @sortedyuan/maybecode build` also creates this CLI bundle.
Keep `dist/bin.js` and its `dist/cli/` chunks together. The package's library
exports continue to use the TypeScript-generated modules. CLI commands load their
implementation when selected; image codecs and Web server assets load when used.

## Choose the relevant checks

- After building, `pnpm api:check` validates public exports against
  `scripts/api-stability.json`, declaration tags and `api/` reports. Run
  `pnpm api:update` after an intentional API change and review the generated
  differences. See [API stability](../reference/stability.md).
- `pnpm lint --max-warnings 0` runs typed ESLint checks on TypeScript source files under
  `src/` in every workspace package and app.
  ESLint uses TypeScript 5.9; `tsc -b` uses TypeScript 7. CI runs lint on Ubuntu with Node.js 24.
- `pnpm format` formats the repository with Prettier (`printWidth: 120`), and
  `pnpm format:check` reports unformatted files without changing them; CI runs the
  check on Linux with Node.js 24.
- `pnpm docs:check` checks bilingual document pairing, language links, local
  destination files, and code-fence pairing. Review anchors, wording, and examples
  separately.
- `pnpm --filter <package-name> test` checks one package; replace the placeholder
  with its `package.json` name.
- Tests write temporary data under the ignored `.test-output/`. The private
  `@sortedyuan/test-support` package provides `createTestDirectory(t, name)`, which creates
  `.test-output/<name>-XXXXXX` and removes it after the test, and `testOutputRoot` for
  shared fixture directories.
- `pnpm test` runs the offline workspace suite and continues through packages
  before reporting failures. Successful package tests are followed by the file-lock checks.
- `pnpm test:locks`, after `pnpm build`, checks lock ownership, process termination,
  failed initialization and release through actual package and application APIs.
  Windows also runs controlled pending-delete tests using PowerShell and the
  Windows file API. Test data resides under the ignored `.test-output/file-lock-matrix/`;
  Team patch checks remove the temporary source's application lock files after use.
- `pnpm test:coverage` runs the available coverage checks.
- `pnpm test:path-alias` runs the suite with a Windows junction or POSIX symlink
  for temporary paths to detect canonical-path assumptions.
- `pnpm test:package:maybecode`, `pnpm test:package:plugin`, and
  `pnpm test:package:eval` check packed packages in external consumers.

Confirm successful exit codes and review reported failures. A documentation check
does not execute its examples. A package test does not establish live-provider
compatibility.

Set `MAY_GIT_CHECKPOINT_TEST_COMMITS=0` when running `pnpm test:package:maybecode`
to verify startup with automatic Git commits disabled. The default package smoke
configuration enables them.

## Continuous integration

The [CI workflow](../../../.github/workflows/ci.yml) runs on pushes, pull requests,
and manual dispatch from **Actions → CI → Run workflow**. It checks Linux with
Node.js 22 and 24, and Windows and macOS with Node.js 24.

Each environment installs locked dependencies, builds, and runs the offline suite
once. Manual dispatch uses the path-alias suite in the Windows job. Linux on
Node.js 24 additionally checks documentation, Web UI resource synchronization,
MCP Apps browser isolation, the basic example, and May, MaybeClaw, and Eval CLI
help. Browser checks install headless Chromium.

Separate Linux and Windows jobs use `.node-version` and check the packed MaybeCode,
plugin host, and evaluation packages. Local May tarballs supply workspace packages;
external dependencies use the pnpm store or registry. The MaybeCode smoke test
configures a Git identity in its isolated home for the initial project checkpoint.

Read job logs in Actions or the PR checks to locate failures. The matrix describes
the tested environments; support claims require successful runs. CI uses no
provider API keys and does not publish packages.

## Checks requiring additional environments

Real provider checks use the relevant `test:integration` command and configured
credentials. Tests that work with any provider use the model profile named by
`MAY_LIVE_MODEL`, or `defaultModel` from `~/.may/config.json` when the variable
is unset. Adapter-specific provider tests select a profile with that adapter:

```bash
pnpm --filter @sortedyuan/maybeclaw test:integration
```

The MaybeCode reasoning effort test requires known reasoning effort capabilities
for the selected profile. Declare `capabilities` for that profile in the
configuration, or select a profile with known capabilities:

```bash
MAY_LIVE_MODEL=<profile> pnpm test:integration:maybecode
```

System clipboard checks require a Windows desktop session:

```powershell
powershell -NoProfile -STA -File scripts/test-terminal-clipboard.ps1
```

Real terminal input, shortcuts, and resizing require terminal verification.
Record the environment and checks performed. Single-Session tool, Skills,
compaction, and retry tests configure `subagents: false`; cancellation checks also
exercise default delegation. Live and desktop checks run separately from CI's
offline suite.
