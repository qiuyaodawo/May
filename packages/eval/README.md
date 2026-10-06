# `@may/eval`

**English** | [简体中文](README.zh-CN.md)

Run repeatable Agent tasks, evaluate their actual results, retain evidence, and
compare versioned configurations. A case supplies the input, execution limits,
environment and acceptance criteria. An experiment fixes cases, variants,
repetitions, concurrency and scheduling seed before executing any trial.

Public entry points are `@may/eval`, `@may/eval/application`,
`@may/eval/coordination` and `@may/eval/file-store`. The main entry includes the
runner, component registry, types, built-in environments and evaluators, and
report comparison functions. The file store requires Node.js >=22.16.0.

The private CLI and executable examples live in `apps/eval`. From the repository:

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

Suite modules are trusted host programs. Directory copies provide independent
files; environment capability declarations describe process, network and
credential isolation separately. Store outputs and evaluators outside the
candidate workspace. Hosts needing enforced isolation supply an environment
with the required capabilities.

Read the [English guide](../../docs/en/guides/eval.md) or
[简体中文指南](../../docs/zh-CN/guides/eval.md) for the public interfaces,
lifecycle, restart behavior, grading, evidence controls, metrics and verification.
The release package scope is explicitly `@may/eval`; `@may/eval-cli` is private.
Its complete runtime dependency chain is checked by packed-consumer verification.
