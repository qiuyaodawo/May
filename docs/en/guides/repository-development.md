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

## Choose the relevant checks

- `pnpm docs:check` checks bilingual document pairing, language links, local
  destination files, and code-fence pairing. Review anchors, wording, and examples
  separately.
- `pnpm --filter <package-name> test` checks one package; replace the placeholder
  with its `package.json` name.
- `pnpm test` runs the offline workspace suite and continues through packages
  before reporting failures.
- `pnpm test:coverage` runs the available coverage checks.
- `pnpm test:path-alias` runs the suite with a Windows junction or POSIX symlink
  for temporary paths to detect canonical-path assumptions.
- `pnpm test:package:maybecode`, `pnpm test:package:plugin`, and
  `pnpm test:package:eval` check packed packages in external consumers.

Confirm successful exit codes and review reported failures. A documentation check
does not execute its examples. A package test does not establish live-provider
compatibility.

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
credentials. For example, MaybeClaw requires `MAYBECLAW_LIVE_MODEL` and provider
credentials:

```bash
pnpm --filter @may/maybeclaw test:integration
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
