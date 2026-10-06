import { Ajv } from "ajv";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { EvalEvaluator, EvaluationCheck, EvaluationContext, EvaluationResult, JsonValue } from "./types.js";
import { readFileManifest, within, type FileManifestEntry } from "./environment.js";
import { startEvalProcess, type CommandOutcome, type EvalCommand } from "./process.js";
import { nodeEvalCommand, type NodeEvalCommand } from "./command.js";

export function createCommandEvaluator(options: {
  readonly id: string;
  readonly version: string;
  readonly command: (context: EvaluationContext) => EvalCommand;
  readonly expectedExitCode?: number;
  readonly validate?: EvalEvaluator["validate"];
  readonly confirmTermination?: (bindings: { readonly context: EvaluationContext; readonly command: EvalCommand; readonly outcome: CommandOutcome; readonly signal: AbortSignal }) => boolean | Promise<boolean>;
}): EvalEvaluator {
  return {
    id: options.id, version: options.version,
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    async evaluate(context, signal) {
      const command = options.command(context);
      const outcome = await startEvalProcess(command, signal).result;
      const confirmed = options.confirmTermination === undefined ? false : await options.confirmTermination({ context, command, outcome, signal: AbortSignal.timeout(context.case.limits.cleanupTimeoutMs) });
      if (typeof confirmed !== "boolean") throw new TypeError("Evaluator termination verifier must return a boolean");
      const evidence = await context.evidenceSink.write({ id: `${options.id}-command`, mediaType: "application/json",
        content: JSON.stringify({ exitCode: outcome.exitCode, signal: outcome.signal, stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated,
          processId: outcome.processId, processTerminationConfirmed: outcome.processTerminationConfirmed, terminationConfirmed: confirmed }) });
      if (!confirmed || !outcome.processTerminationConfirmed) throw Object.assign(new Error("Evaluator command termination could not be confirmed by its host"), { code: "termination-unconfirmed" });
      signal.throwIfAborted();
      const verdict = outcome.exitCode === (options.expectedExitCode ?? 0) ? "passed" as const : "failed" as const;
      return { verdict, checks: [{ id: options.id, verdict, message: `Command exit code: ${outcome.exitCode}`, evidence: [evidence] }], evidence: [evidence] };
    },
  };
}

export function createNodeCommandEvaluator(options: {
  readonly id: string;
  readonly version: string;
  readonly command: (context: EvaluationContext) => NodeEvalCommand;
  readonly expectedExitCode?: number;
  readonly validate?: EvalEvaluator["validate"];
}): EvalEvaluator {
  return createCommandEvaluator({
    id: options.id, version: options.version,
    ...(options.expectedExitCode === undefined ? {} : { expectedExitCode: options.expectedExitCode }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    command: context => nodeEvalCommand(options.command(context)),
    confirmTermination: ({ outcome }) => outcome.processTerminationConfirmed,
  });
}

export function createJsonSchemaEvaluator(options: {
  readonly id?: string;
  readonly version?: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly read?: (context: EvaluationContext, signal: AbortSignal) => Promise<unknown>;
}): EvalEvaluator {
  const validate = new Ajv({ strict: true, allErrors: true }).compile(options.schema);
  const id = options.id ?? "json-schema";
  return {
    id, version: options.version ?? "1",
    validate(values) { if (Object.keys(values).length) throw new TypeError("JSON Schema belongs to the registered evaluator"); },
    async evaluate(context, signal) {
      signal.throwIfAborted();
      const data = options.read === undefined ? context.execution.output : await options.read(context, signal);
      const valid = validate(data);
      const evidence = await context.evidenceSink.write({ id: `${id}-validation`, mediaType: "application/json",
        content: JSON.stringify({ valid, errors: validate.errors ?? [] }) });
      const verdict = valid ? "passed" as const : "failed" as const;
      return { verdict, checks: [{ id, verdict, evidence: [evidence] }], evidence: [evidence] };
    },
  };
}

export interface FileRequirement {
  readonly path: string;
  readonly exists?: boolean;
  readonly equals?: string;
  readonly includes?: string;
  readonly sha256?: string;
}
export function createFileChangesEvaluator(options: {
  readonly id?: string;
  readonly version?: string;
  readonly allowedPaths: readonly string[];
  readonly requirements?: readonly FileRequirement[];
}): EvalEvaluator {
  for (const name of [...options.allowedPaths, ...(options.requirements ?? []).map(item => item.path)]) validateRelativePath(name);
  const allowed = new Set(options.allowedPaths);
  const id = options.id ?? "file-changes";
  return {
    id, version: options.version ?? "1",
    validate(values) { if (Object.keys(values).length) throw new TypeError("File requirements belong to the registered evaluator"); },
    async evaluate(context, signal) {
      signal.throwIfAborted();
      const data = context.target.data;
      const baseline = manifest(data?.baselineManifest);
      const after = manifest(data?.manifest);
      const beforeMap = new Map(baseline.map(entry => [entry.path, entry]));
      const afterMap = new Map(after.map(entry => [entry.path, entry]));
      if (!context.target.workspacePath) throw new Error("File evaluator needs a frozen workspace");
      const actual = await readFileManifest(context.target.workspacePath, signal, Math.max(1, after.length), Math.max(1, after.reduce((sum, entry) => sum + entry.bytes, 0)));
      if (actual.length !== after.length || actual.some(entry => afterMap.get(entry.path)?.sha256 !== entry.sha256 || afterMap.get(entry.path)?.bytes !== entry.bytes)) throw new Error("Evaluation snapshot contents changed");
      const changed = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].filter(path => beforeMap.get(path)?.sha256 !== afterMap.get(path)?.sha256).sort();
      const checks: EvaluationCheck[] = [{ id: "allowed-paths", verdict: changed.every(path => allowed.has(path)) ? "passed" : "failed",
        message: JSON.stringify({ changed, unexpected: changed.filter(path => !allowed.has(path)) }) }];
      for (const requirement of options.requirements ?? []) {
        signal.throwIfAborted();
        const exists = afterMap.has(requirement.path);
        let passed = requirement.exists === false ? !exists : exists;
        if (exists && (requirement.equals !== undefined || requirement.includes !== undefined)) {
          const content = await readEvaluationFile(context.target.workspacePath, requirement.path, signal);
          if (requirement.equals !== undefined) passed &&= content === requirement.equals;
          if (requirement.includes !== undefined) passed &&= content.includes(requirement.includes);
        }
        if (requirement.sha256 !== undefined) passed &&= afterMap.get(requirement.path)?.sha256 === requirement.sha256;
        checks.push({ id: `file:${requirement.path}`, verdict: passed ? "passed" : "failed" });
      }
      const evidence = await context.evidenceSink.write({ id: `${id}-manifest`, mediaType: "application/json", content: JSON.stringify({ changed, checks }) });
      return { verdict: checks.every(check => check.verdict === "passed") ? "passed" : "failed", checks, evidence: [evidence] };
    },
  };
}

export function createCompositeEvaluator(options: { readonly id: string; readonly version: string; readonly evaluators: readonly EvalEvaluator[] }): EvalEvaluator {
  if (!options.evaluators.length) throw new TypeError("Composite evaluator requires checks");
  return {
    id: options.id, version: options.version,
    validate(values) { for (const evaluator of options.evaluators) evaluator.validate?.(values); },
    async evaluate(context, signal) {
      const results: EvaluationResult[] = [];
      for (const evaluator of options.evaluators) { signal.throwIfAborted(); results.push(await evaluator.evaluate(context, signal)); }
      const verdict = results.some(result => result.verdict === "failed") ? "failed" : results.every(result => result.verdict === "passed") ? "passed"
        : results.some(result => result.verdict === "awaiting-review") ? "awaiting-review" : "inconclusive";
      return { verdict, checks: results.flatMap(result => result.checks), evidence: results.flatMap(result => result.evidence) };
    },
  };
}

export function createHumanEvaluator(id = "human", version = "1"): EvalEvaluator {
  return { id, version, async evaluate(_context, signal) { signal.throwIfAborted(); return { verdict: "awaiting-review", checks: [], evidence: [] }; } };
}

export async function readEvaluationFile(directory: string, path: string, signal: AbortSignal, maxBytes = 1_048_576): Promise<string> {
  validateRelativePath(path);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("Evaluation file limit must be a positive integer");
  signal.throwIfAborted();
  const root = await realpath(directory);
  const target = resolve(root, path);
  if (!within(root, target) || !within(root, await realpath(target))) throw new Error("Evaluation file is outside snapshot");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Evaluation file must be a bounded regular file");
  const content = await readFile(target, "utf8");
  if (Buffer.byteLength(content) > maxBytes) throw new Error("Evaluation file exceeds its byte limit");
  signal.throwIfAborted();
  return content;
}
function validateRelativePath(path: string) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || /[\u0000-\u001f]/u.test(path)) throw new TypeError("File requirements need normalized relative paths");
}
function manifest(value: JsonValue | undefined): readonly FileManifestEntry[] {
  if (!Array.isArray(value)) throw new TypeError("File evaluator requires snapshot manifests");
  const paths = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid snapshot manifest entry");
    const item = entry as Record<string, JsonValue>;
    if (typeof item.path !== "string" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new TypeError("Invalid snapshot manifest entry");
    validateRelativePath(item.path);
    if (paths.has(item.path)) throw new TypeError("Duplicate snapshot manifest path");
    paths.add(item.path);
    return { path: item.path, sha256: item.sha256, bytes: item.bytes };
  });
}
