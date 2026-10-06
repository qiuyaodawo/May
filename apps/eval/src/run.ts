import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EvalRegistry,
  EvalRunner,
  assertJson,
  compareEvalReports,
  createEvalReport,
  fingerprint,
  isSuccessful,
  renderEvalReportMarkdown,
  serializableExperiment,
  type EvalComparisonThresholds,
  type EvalExperiment,
  type EvalReport,
  type EvaluationResult,
} from "@may/eval";
import { FileEvalStore } from "@may/eval/file-store";
import { CLI_USAGE, parseCliArgs } from "./args.js";
import { formatCliError } from "./errors.js";

export interface EvalSuite {
  readonly experiment: EvalExperiment;
  readonly registry: EvalRegistry;
}

export async function runCli(args: readonly string[], options: {
  readonly signal?: AbortSignal;
  readonly stdout?: (text: string) => void;
} = {}): Promise<number> {
  const command = parseCliArgs(args);
  const output = options.stdout ?? (value => process.stdout.write(`${value}\n`));
  if (command === undefined) { output(CLI_USAGE); return 0; }
  const values = command.options;
  if (command.command === "validate" || command.command === "run") {
    const suite = await loadSuite(values.suite!);
    const store = new FileEvalStore({ directory: resolve(values.output ?? ".eval-results") });
    const runner = new EvalRunner({ registry: suite.registry, store, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    runner.validate(suite.experiment);
    if (command.command === "validate") { output(`Validated ${suite.experiment.id}`); return 0; }
    const location = resolve(store.directory, suite.experiment.id);
    await preserveFailureReport(() => runner.run(suite.experiment), store, suite.experiment.id, location);
    const report = await exportReport(store, suite.experiment.id, location);
    output(JSON.stringify({ experimentId: report.experimentId, directory: location, planned: report.planned, variants: report.variants }));
    return successfulReport(report) ? 0 : 1;
  }
  if (command.command === "resume") {
    const suite = await loadSuite(values.suite!);
    const { store, experimentId, directory } = experimentStore(values.experiment!);
    const plan = await store.readPlan(experimentId);
    if (fingerprint(serializableExperiment(suite.experiment)) !== fingerprint(plan.experiment)) {
      throw new Error("Suite configuration differs from the accepted experiment plan");
    }
    const runner = new EvalRunner({ registry: suite.registry, store, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    await preserveFailureReport(() => runner.resume(experimentId, suite.experiment), store, experimentId, directory);
    const report = await exportReport(store, experimentId, directory);
    output(JSON.stringify({ experimentId, directory, variants: report.variants }));
    return successfulReport(report) ? 0 : 1;
  }
  if (command.command === "report") {
    const { store, experimentId, directory } = experimentStore(values.experiment!);
    const report = await exportReport(store, experimentId, values.output === undefined ? directory : resolve(values.output));
    output(renderEvalReportMarkdown(report));
    return 0;
  }
  if (command.command === "grade") {
    const { store, experimentId, directory } = experimentStore(values.experiment!);
    const result = await readJsonFile(values.result!) as EvaluationResult;
    const suite = values.suite === undefined ? undefined : await loadSuite(values.suite);
    const runner = new EvalRunner({ registry: new EvalRegistry(), store });
    const state = await runner.grade(experimentId, values.trial!, values.evaluator!, result, suite?.experiment);
    await exportReport(store, experimentId, directory);
    output(JSON.stringify({ trialId: state.trial.id, taskVerdict: state.taskVerdict, awaitingReview: state.awaitingReview, evaluations: state.evaluations }));
    return state.taskVerdict === "passed" && !state.awaitingReview ? 0 : 1;
  }
  const baselineLocation = experimentStore(values.baseline!);
  const candidateLocation = experimentStore(values.candidate!);
  const baseline = await readReport(baselineLocation.store, baselineLocation.experimentId);
  const candidate = await readReport(candidateLocation.store, candidateLocation.experimentId);
  const thresholds = values.thresholds === undefined ? {} : await readThresholds(values.thresholds);
  const comparison = compareEvalReports(baseline, candidate, thresholds, {
    ...(values["baseline-variant"] === undefined ? {} : { baselineVariantId: values["baseline-variant"] }),
    ...(values["candidate-variant"] === undefined ? {} : { candidateVariantId: values["candidate-variant"] }),
  });
  const release = await candidateLocation.store.acquire(candidateLocation.experimentId);
  try {
    await atomicWrite(join(candidateLocation.directory, "comparison.json"), JSON.stringify(comparison, null, 2));
  } finally { await release(); }
  output(JSON.stringify(comparison, null, 2));
  return comparison.passed ? 0 : 1;
}

async function loadSuite(path: string): Promise<EvalSuite> {
  const value = await import(pathToFileURL(resolve(path)).href) as Partial<EvalSuite>;
  if (typeof value.experiment !== "object" || value.experiment === null || !(value.registry instanceof EvalRegistry)) {
    throw new TypeError("A suite must export experiment and an EvalRegistry instance");
  }
  return { experiment: value.experiment, registry: value.registry };
}

function experimentStore(path: string): { readonly store: FileEvalStore; readonly experimentId: string; readonly directory: string } {
  const directory = resolve(path);
  return { store: new FileEvalStore({ directory: dirname(directory) }), experimentId: basename(directory), directory };
}

async function readReport(store: FileEvalStore, experimentId: string): Promise<EvalReport> {
  const plan = await store.readPlan(experimentId);
  return createEvalReport(plan, await store.listTrials(experimentId));
}

async function exportReport(store: FileEvalStore, experimentId: string, directory: string): Promise<EvalReport> {
  const release = await store.acquire(experimentId);
  try {
    const report = await readReport(store, experimentId);
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, "report.json"), JSON.stringify(report, null, 2));
    await atomicWrite(join(directory, "report.md"), renderEvalReportMarkdown(report));
    return report;
  } finally { await release(); }
}

async function preserveFailureReport(operation: () => Promise<unknown>, store: FileEvalStore, experimentId: string, directory: string): Promise<void> {
  try { await operation(); } catch (error) {
    try { await exportReport(store, experimentId, directory); } catch (reportError) {
      throw new AggregateError([error, reportError], `Execution failed: ${formatCliError(error)}. Report persistence failed: ${formatCliError(reportError)}`);
    }
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.writing`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${content}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
}

async function readJsonFile(path: string): Promise<unknown> {
  const absolute = resolve(path);
  if ((await stat(absolute)).size > 33_554_432) throw new RangeError("CLI JSON input exceeds 32 MiB");
  const value: unknown = JSON.parse(await readFile(absolute, "utf8"));
  assertJson(value);
  return value;
}

async function readThresholds(path: string): Promise<EvalComparisonThresholds> {
  const value = await readJsonFile(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Thresholds must be a JSON object");
  for (const key of Object.keys(value)) if (!["minimumSuccessRate", "allowedRegressedCases", "maxCostIncreaseRatio"].includes(key)) throw new TypeError(`Unknown comparison threshold: ${key}`);
  if ("allowedRegressedCases" in value && (!Array.isArray(value.allowedRegressedCases) || !value.allowedRegressedCases.every(id => typeof id === "string"))) {
    throw new TypeError("allowedRegressedCases must contain case identifiers");
  }
  return value as EvalComparisonThresholds;
}

function successfulReport(report: EvalReport): boolean {
  return report.trials.length === report.planned && report.trials.every(isSuccessful);
}
