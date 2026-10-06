# Executable evaluation suite

**English** | [简体中文](README.zh-CN.md)

The suite starts a real Node.js command in each independent directory. It reads
`input.json`, writes `result.json`, and runs independent command, JSON Schema and
file-change acceptance checks. Two repetitions run concurrently. The case is a
deterministic file task for lifecycle verification; its records measure command
execution. Real model evaluations use the public Agent adapters.

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

`MAY_EVAL_EXAMPLE_ID` selects a fresh experiment identity for another execution.
`MAY_EVAL_EXAMPLE_WORKSPACE_ROOT` overrides the workspace root `.eval-workspaces`.
The execution adapter uses Node's `--permission` mode with reads of its script
and working directory and writes within the working directory. The verifier uses
the same permission restrictions for its frozen directory. Child processes,
workers, native addons and WASI remain disabled, so each managed command can
confirm termination after its immediate process exits. Use the suite with trusted
programs. Suite loading and evidence handling retain host permissions; enforced
isolation requires a host environment with the required capability declarations.
