# Evaluate Agent task results

**English** | [简体中文](../../zh-CN/guides/eval.md)

Use `@may/eval` to execute the same tasks across model, prompt, tool, permission
or Context configurations and check their actual results. Each trial preserves
execution status, acceptance evidence, infrastructure status, human assistance
and resource use.

This guide is for hosts with explicit acceptance requirements. It begins with
the repository's runnable command suite, then explains how to register real
Agent execution and evaluators. Use Node.js 22.16 or later and the pnpm version
declared in `package.json` when running repository commands.

## Running a trusted suite

The private CLI loads a JavaScript suite exporting `experiment` and `registry`.
Importing it executes code with host filesystem, process and network permissions.
Load only trusted modules. The included suite uses actual files and Node.js
processes and requires no model credentials.

1. In the repository root, ensure dependencies are installed and built with
   `pnpm install --frozen-lockfile` and `pnpm build`.
2. Validate the included suite:

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
```

   The validation command prints `Validated file-artifact` for the unchanged
   default suite. Validation checks configuration without starting trials.
3. Run the experiment and inspect its report:

```powershell
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

   The suite plans two trials, writes `result.json` containing an uppercase
   message, and checks the file independently. Inspect execution, acceptance
   and infrastructure outcomes for both trials. Trial IDs and timings vary.
   Reports are saved as `report.json` and `report.md` in the experiment directory.
4. Keep reports and evidence for review. Existing experiment IDs cannot be reused
   for a new run; set `MAY_EVAL_EXAMPLE_ID` to a new ID before repeating the suite.
   To continue interrupted planned work, use the [restart procedure](#restart-and-retry).

`--output` is the store root; the experiment is stored in its own identity-named
directory. Keep that root outside candidate workspaces. Reports remain available
when trial execution or acceptance fails, and the CLI returns a nonzero status.
SIGINT and SIGTERM request cancellation and preserve admitted trial records.

The bundled file-artifact suite executes an actual command which writes a file,
then verifies that file independently. It verifies the evaluation lifecycle and
CLI. Data from that suite describes command execution, without measuring model
task-solving ability. Real Agent evaluation uses the Application or Coordination
adapter with the host's configured model and permission policy.

Library hosts can run registered experiments with the following function. Its
inputs are an `EvalExperiment`, the matching `EvalRegistry`, a host-controlled
store directory and a cancellation signal:

```ts
import { EvalRunner, type EvalExperiment, type EvalRegistry } from "@may/eval";
import { FileEvalStore } from "@may/eval/file-store";

export async function evaluateExperiment(
  experiment: EvalExperiment,
  registry: EvalRegistry,
  directory: string,
  signal: AbortSignal,
) {
  const runner = new EvalRunner({
    registry,
    store: new FileEvalStore({ directory }),
    signal,
    onTrial: state => console.log(state.trial.id, state.taskVerdict),
  });
  runner.validate(experiment);
  return await runner.run(experiment);
}
```

## Cases, variants and registries

An `EvalCase` declares `id`, `version`, `description`, `input`, `environment`,
`evaluators` and `limits`. Each component reference contains an `id`, `version`
and optional JSON `options`. At least one evaluator must be `required`.
`requiredCapabilities` requests environment capabilities; `evaluateAfterLimit`
allows evaluation after an execution limit when termination has been confirmed.

`EvalVariant` declares an execution component and a JSON `configuration` snapshot.
It may override `runBudget` and mark `assisted` execution. Credentials remain in
host configuration, outside the serialized snapshot. Configuration references,
model names, prompt versions and tool versions belong in that snapshot.

`EvalExperiment` fixes its identity, cases, variants, repetition count,
concurrency, seed and evidence policy. `EvalRegistry` holds explicitly registered
environment, execution and evaluator components. Exact component versions are
validated before work starts. Validation also checks budgets, timeouts, identities,
required evaluators and requested environment capabilities.

Register components with `registerEnvironment()`, `registerExecution()` and
`registerEvaluator()`. Host callbacks and their captured configuration are trusted
implementation code. Save their meaningful settings in component options or the
variant snapshot and change the component version whenever behavior changes.

The runner saves the complete trial plan and configuration fingerprints before
executing any task. Every `case × variant × repetition` receives a unique trial
identity. A seeded, interleaved schedule distributes variant execution order.
The seed controls that order; provider randomness has its own configuration.

## Environment lifecycle

`EvalEnvironmentAdapter.prepare()` creates independent resources and returns a
`PreparedEnvironment`. Its `executionTarget` exposes only resources needed for
candidate execution. After all Agent work terminates, `freeze()` returns the
`EvaluationTarget`. `dispose()` cleans up owned resources and supports repeated
calls. Restart recovery uses the environment's `recover()` hook when available.

The capability fields are `independentResources`, `filesystemIsolation`,
`processIsolation`, `networkIsolation`, `credentialIsolation` and optional
`protectedEvaluationResources`. A local directory
copy creates independent files while host processes still retain host permissions.
It cannot enforce access restrictions on acceptance code, answers or credentials.
Cases requiring those restrictions must request suitable capabilities and use a
host-supplied isolated environment. Capability declarations are host promises;
validate the actual environment through its own installation and isolation tests.

Acceptance programs, expected answers, store files and grading credentials stay
outside the candidate workspace. Services require independent databases,
namespaces or accounts. Environments without independent resources reject
concurrent execution. Process, network and credential boundaries are managed by
the environment rather than inferred from directory placement.

`createLocalDirectoryEnvironment({ sourceDirectory, rootDirectory, id?, version?,
maxFiles?, maxBytes?, excludeNames? })` provides the built-in directory adapter.
Its defaults limit snapshots to 10,000 files and 67,108,864 bytes. `.git`,
`node_modules`, `.env`, `.env.*` and `.eval-results` are excluded by basename; hosts add
project-specific exclusions. Baseline and frozen snapshots remain available for
later evaluation; disposal removes the active candidate workspace. Hosts manage
retention of those snapshots and the store separately.

## Execution and cancellation

Trials follow `prepare → execute → freeze → evaluate → cleanup`. Every stage
records its start, end, duration and outcome. Records are persisted before stage
transitions. Each stage has its own timeout; execution also receives a `RunBudget`.

An execution adapter creates an `EvalExecution` with `execute()`, `cancel()` and
`close()`. It must report `terminationConfirmed`. On timeout or cancellation the
runner requests termination, waits for confirmation and preserves evidence.
Without confirmation it records `termination-unconfirmed` and prevents evaluation
that could modify resources still used by the Agent. Cleanup failures are retained
alongside the original failure.
Pending freeze and evaluation work must finish before environment disposal.
Unconfirmed evaluator termination retains the environment and stops further
evaluation. If waiting exceeds the cleanup limit, the resource remains available
for host inspection.

`createCommandExecutionAdapter({ id, version, command, confirmTermination?,
validate? })` runs an explicit executable and argument array in an absolute
working directory. `confirmTermination({ context, command, outcome, signal })`
is the host's verification that every process started for the task has terminated.
The process outcome's `processTerminationConfirmed` refers to the immediate
process. A successful exit alone cannot establish termination of its descendants.
Without a host verifier the execution reports `terminationConfirmed: false`, and
the runner retains the active directory for inspection.

`createNodeCommandExecutionAdapter({ id, version, command, validate? })` supports
trusted Node.js programs. The command returns an absolute `script` and `cwd`,
with optional `args`, `env` and `maxOutputBytes`. It uses Node's `--permission`
mode, grants reads of the script and working directory and writes within that
directory, and denies child processes, workers, native addons and WASI.
`NODE_OPTIONS` and `NODE_PATH` overrides are rejected. This allows termination
confirmation for that controlled program when its process terminates.
Node permission mode supports trusted code; enforced process and credential
isolation still requires the host environment's corresponding capabilities.

The Application adapter consumes Application events and preserves Session and
Run identities. The Coordination adapter waits for the task graph and records
coordination and node execution identities. Yielded, waiting and recovery states
need explicit host handling. Permissions are provided by the host: policy
approvals and real human approvals are recorded, and unavailable interaction
terminates with an explicit result. Human waiting time is accounted separately.

`createApplicationExecutionAdapter({ version, open, input?, approvals?,
continueAfterYield?, maxContinuations? })` is exported by `@may/eval/application`.
Its `open({ context, tracer, budget })` callback must return a fresh
`AgentApplication`. Supply `tracer` to that Application and use
`budget.wrapModel(realModel)` with either `budget.wrapTools(realTools)` or
`budget.wrapToolExecutor(realExecutor)`. The budget spans all inputs and
continuations. Without a custom `input()` mapper, case messages must all have
`role: "user"`. The default continuation limit is 32.
Its output preserves final text as `text` and structured values as a `json`
array; absent content is omitted.

`createCoordinationExecutionAdapter({ version, create, outputTaskId?, approvals? })`
is exported by `@may/eval/coordination`. Its `create({ context, tracer, budget })`
callback creates a fresh `CoordinationRuntime`, and all model and tool routes use
the same supplied budget wrappers. Limits apply across the complete task graph.
An unbound budget is rejected. `outputTaskId` selects a task's final text; without
it the execution result includes all task identities, states and final texts.

An approval handler supplies `decide(request, signal)`. Set its `assisted: true`
for human decisions; fixed host policies remain automatic. A variant may explicitly
set `assisted: true`. Recorded human interventions also mark its report as assisted.
The adapter processes approval requests and decisions and measures waiting.
Telemetry evidence retains request and Session identities, request and resolution
timestamps, decision and status, without tool input.

## Restart and retry

For the included suite, resume with its original module and experiment directory:

```powershell
pnpm eval resume --suite apps/eval/examples/suite.mjs --experiment .eval-results/file-artifact
```

Restore the same `MAY_EVAL_EXAMPLE_ID` if it was set when creating the experiment.

`resume()` preserves completed trials and starts only trials which have not
started. Previously started trials without a final state become `interrupted`.
If execution began, the execution adapter's optional `recover()` must confirm that
it terminated before the environment's `recover()` performs cleanup. Without
confirmation the record retains `termination-unconfirmed` and its directory stays
available for host inspection. Unstarted trials still use independent resources.
Registry versions and experiment fingerprints must match the accepted plan.

Pass the original trusted experiment to `resume(experimentId, experiment)`,
`retry(experimentId, trialId, experiment)` or
`evaluateTrial(experimentId, trialId, evaluatorId, experiment)` when it contains
runtime redaction callbacks. Manual grading uses
`grade(experimentId, trialId, evaluatorId, result, experiment)` for the same purpose.
The CLI restores this experiment from `--suite`, including its optional grade flag.
Callback identities and versions are persisted; a missing required callback
prevents continuation.

The API's explicit `retry()` creates a new trial linked by `retryOf`, preserving
the original result. There is no automatic task rerun. Provider retries follow
the variant's provider policy and are included in request-attempt accounting.
Storage corruption or incompatible schema versions fail immediately.

## Evaluators and grading

An `EvalEvaluator` receives the fixed target, execution result, case, variant,
options, evidence sink and event emitter. It returns a verdict, checks, optional
scores and evidence references. Built-in evaluators cover commands, JSON Schema,
file changes and composition. Command checking specifies executable, arguments,
working directory and timeout. File checks inspect allowed change scope and
declared contents. Mature formats use their corresponding parsing libraries.

The built-in factories are `createCommandEvaluator({ id, version, command,
confirmTermination?, expectedExitCode?, validate? })`,
`createNodeCommandEvaluator({ id, version, command, expectedExitCode?, validate? })`,
`createJsonSchemaEvaluator({ schema, read?, id?, version? })`,
`createFileChangesEvaluator({ allowedPaths, requirements?, id?, version? })`,
`createCompositeEvaluator({ id, version, evaluators })` and
`createHumanEvaluator(id?, version?)`. Commands use explicit executable and
argument arrays. The schema evaluator inspects `execution.output` unless `read()`
supplies a value. File requirements support existence, exact text, included text
and SHA-256 checks against the frozen snapshot. Allowed paths are exact normalized
relative paths. Composite evaluators execute their registered checks in order.

The general command evaluator requires the same host termination verification as
the general execution adapter. Missing confirmation produces
`termination-unconfirmed` and an inconclusive evaluation. The Node evaluator uses
the same controlled Node permission mode and absolute script/working-directory
configuration as the Node execution adapter.

File validation recomputes the frozen directory's complete manifest and compares
paths, byte counts and SHA-256 values with the stored snapshot before evaluating
requirements. Changed snapshot contents reject evaluation. `readEvaluationFile()`
requires a normalized relative path and a regular file within the frozen directory,
rejects symbolic links, and enforces its byte limit both before and after reading.
Its default limit is 1,048,576 bytes; hosts may supply an explicit positive limit.

Required results determine `taskVerdict`: any failed required check yields
`failed`; all required checks passing yields `passed`; otherwise it is
`inconclusive`. Optional checks retain evidence and scores without changing that
verdict. A case can make a declared score threshold part of its evaluator.

Human review returns `awaiting-review`. A later grade appends an evaluator revision
and preserves earlier revisions. To submit a JSON `EvaluationResult`:

```powershell
pnpm eval grade --experiment .eval-results/file-artifact --trial <trialId> --evaluator <evaluatorId> --result ./review-result.json
```

Add `--suite ./suite.mjs` when the experiment declares a custom redactor.

`createModelEvaluator({ version, modelId, promptVersion, rules, model, runBudget,
input?, responseFormat?, scoreThresholds?, id? })` runs a real May model call for optional model
grading. The host provides the model and rubric. The evaluator preserves the
model identity, prompt version, rules, schema, raw result and evidence, and keeps
candidate content in the data being graded. Scores range from zero to one.
Invalid output, inconsistent checks or failed grading requests produce an
`inconclusive` result. Candidate and grader consumption are recorded separately.
`scoreThresholds` may be declared in the registered evaluator or its case reference
options. Each threshold is in `[0, 1]`; a missing requested score is inconclusive
and a score below its threshold fails the corresponding check. Unspecified scores
have no inferred threshold.

## Outcomes and metrics

Each trial preserves `executionStatus`, `taskVerdict` and `infrastructureStatus`
separately. A task may satisfy acceptance after hitting a limit; the record still
preserves `limited` execution. Infrastructure errors preserve the failing stage
and error code. Unknown causes remain `unknown`.

The runner records duration, approval waiting, model calls, provider attempts,
retry waiting, tool calls and errors, Context compactions, human interventions,
tokens and cost. Stable event identities prevent double counting. Missing usage
or pricing remains missing with a reason. `UsageCost` includes completeness and
the price version supplied by the host. Grader metrics have their own totals.

Application and Coordination adapters propagate Core telemetry correlation and
can associate trial evidence with Session, Run, coordination and trace identities.
Assessment revisions can be projected into Observability `TaskAssessment`;
EvalStore remains the durable experiment source. A DiagnosticsStore is useful
for correlated inspection and has its own retention limits.

## Evidence and persistence

`FileEvalStore({ directory })` stores versioned JSON plans, trial states, JSONL
events and evidence files. It permits one writer per experiment through a SQLite
exclusive transaction in `writer-lock.sqlite`; the operating system releases
ownership after process termination. State replacement is atomic; the store
validates identities and schema before reading or writing. Keep the ownership
database in place while any process uses the experiment.

Default events include allowlisted accounting and identity fields. The evidence
policy limits item bytes, trial bytes and item count. Content retention requires
`retainContent: true`. A host `redact` function removes project-specific secrets
before persistence. Do not place credentials in input, component options or
configuration snapshots. Hosts own filesystem access, backups, retention and
deletion of the plaintext records.
The same redaction also covers retained output, error messages, evaluation check
messages and evidence labels.

Plan and state records are limited to 32 MiB. Each telemetry event is limited to
64 KiB. A trial can append 20,000 events or 16 MiB to its event file; each in-memory
metrics scope accepts at most 10,000 unique events. These limits stop work with
an explicit error. Full execution output is retained only with `retainContent: true`
and is subject to redaction and evidence size limits.

A custom `redact` callback requires `redactorId` and `redactorVersion` in its
evidence policy. These fields are saved and compared, while the callback stays in
the trusted host. Restoring the same callback is required after a restart.

The default limits are 65,536 bytes per evidence item, 1,048,576 bytes per trial,
and 64 items. Identifiers use 1–128 characters from letters, digits, `.`, `_` and
`-`, beginning with a letter or digit. JSON values must be finite, lossless and
no more than 32 levels deep. Configuration fields with credential names are
rejected before execution. Host redaction remains necessary for project-specific
credentials inside text.

## Reports and comparison gates

Reports use all planned trials as the success-rate denominator. A success needs
normal completed execution, passed required acceptance, and successful
infrastructure handling. They also show unstarted, failed, cancelled, limited,
interrupted, inconclusive and awaiting-review records. Assisted and automatic
variants retain separate summaries.

Comparison requires matching case, environment and evaluator versions and
fingerprints. It includes all repetitions, per-case changes, metric coverage and
time and cost distributions. Incomplete metrics remain visibly incomplete.
Time and cost comparisons use the same case set.

```powershell
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate --thresholds ./thresholds.json
```

Thresholds explicitly specify the minimum success rate, permitted regression and
cost limits. No thresholds are inferred. A rejected gate returns a nonzero status
and retains its comparison report.

```json
{
  "minimumSuccessRate": 0.9,
  "allowedRegressedCases": [],
  "maxCostIncreaseRatio": 0.1
}
```

`minimumSuccessRate` is in `[0, 1]`. An empty `allowedRegressedCases` permits no
case regression; omitting it leaves that gate unconfigured. A cost ratio of `0.1`
permits a 10% increase and requires complete measurements in the same currency.
Without a thresholds file comparison checks compatibility and reports changes.
Use `--baseline-variant` and `--candidate-variant` when either experiment contains
multiple variants. Uninstrumented external commands report model consumption as
unknown, so they cannot satisfy a complete-cost comparison gate.

## Package scope and verification

The release package scope for this feature is `@may/eval`.
`@may/eval-cli` and executable suites remain private. Public runtime dependencies
include Core, Application, Coordination, Observability and Permissions as well as
the libraries used for schema validation and process cancellation. Packed-consumer
verification checks installation and execution outside the repository.

```powershell
pnpm --filter @may/eval test
pnpm --filter @may/eval-cli test
pnpm test:package:eval
pnpm test:integration:eval
pnpm docs:check
```

Offline tests use actual files, processes, environment preparation and command
acceptance. Real-model integration requires configured provider access and records
the model, usage and acceptance evidence. Passing offline tests establishes
lifecycle and acceptance behavior. Model success, isolation enforcement and
performance conclusions require their corresponding real environment evidence.

`test:integration:eval` reads the host's May configuration through
`loadMayConfig()` and selects its configured provider and model. It executes real
single-Agent and task-graph trials, model grading, permission handling and budget
checks and consumes provider quota. Records remain under `eval-verification/live/run-*` for review; they
describe the configured tasks and model used in that execution.
