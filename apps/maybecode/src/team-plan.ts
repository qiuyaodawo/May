import { open } from "node:fs/promises";
import type { CoordinationLimits, TaskSpec } from "@may/coordination";
import { resolveRunBudget, type RunBudget } from "@may/core";
import { MaybeCodeUsageError } from "./errors.js";
import { parseTeamChecks, type TeamCheckSpec } from "./team-verification.js";

export type TeamMode = "read-only" | "coding";
export type TeamPreset = "supervisor" | "pipeline" | "parallel";
export type TeamToolName = "read" | "list_files" | "publish_artifact" | "read_artifact" | "write" | "edit" | "run_check" | "submit_report";

export interface TeamRole {
  readonly model?: string;
  readonly instructions?: string;
  readonly tools: readonly TeamToolName[];
  readonly delegateTo: readonly string[];
  readonly messaging: boolean;
  readonly runBudget?: RunBudget;
}

/** Normalized immutable input. Authority mode is host-selected, never part of a plan. */
export interface TeamPlan {
  readonly format: 1;
  readonly name?: string;
  readonly roles: Readonly<Record<string, TeamRole>>;
  readonly tasks: readonly TaskSpec[];
  readonly resultTaskId: string;
  readonly limits?: Partial<CoordinationLimits>;
  readonly checks: readonly TeamCheckSpec[];
}

const MAX_PLAN_BYTES = 1_048_576;
const READ_TOOLS: readonly TeamToolName[] = ["read", "list_files", "publish_artifact", "read_artifact", "submit_report", "run_check"];
const ALL_TOOLS: readonly TeamToolName[] = [...READ_TOOLS, "write", "edit"];
const LIMIT_CAPS = {
  maxConcurrent: 8, maxTasks: 128, maxDurationMs: 86_400_000, maxOutputBytes: 262_144,
  maxDepth: 8, maxTaskTurns: 64, maxMessages: 4096, maxMessageBytes: 65_536,
  maxHandoffs: 16, maxHandoffBytes: 65_536, maxAttempts: 8, maxGraphChanges: 128,
} as const;

/** Reject misspelled permissions and malformed graphs before opening any model or workspace. */
export function parseTeamPlan(value: unknown, options: { readonly mode?: TeamMode } = {}): TeamPlan {
  const mode = options.mode ?? "read-only";
  if (mode !== "read-only" && mode !== "coding") fail("Invalid team mode");
  const plan = object(value, "plan", ["format", "name", "roles", "tasks", "resultTaskId", "limits", "checks"]);
  if (plan.format !== 1) fail("plan.format must be 1");
  const name = plan.name === undefined ? undefined : text(plan.name, "plan.name", 128);
  const roleValues = object(plan.roles, "plan.roles");
  if (Object.keys(roleValues).length < 1 || Object.keys(roleValues).length > 16) fail("plan.roles must contain 1-16 roles");
  const roles: Record<string, TeamRole> = {};
  for (const [id, value] of Object.entries(roleValues)) {
    identifier(id, "role id");
    const role = object(value, `role ${id}`, ["model", "instructions", "tools", "delegateTo", "messaging", "runBudget"]);
    const model = role.model === undefined ? undefined : text(role.model, `role ${id}.model`, 128);
    const instructions = role.instructions === undefined ? undefined : text(role.instructions, `role ${id}.instructions`, 16_384);
    const tools = role.tools === undefined ? [...READ_TOOLS] : stringArray(role.tools, `role ${id}.tools`, ALL_TOOLS.length);
    for (const tool of tools) {
      if (!ALL_TOOLS.includes(tool as TeamToolName)) fail(`Unknown tool in role ${id}: ${tool}`);
      if (mode === "read-only" && (tool === "write" || tool === "edit")) fail(`Tool ${tool} in role ${id} requires --mode coding`);
    }
    const delegateTo = role.delegateTo === undefined ? [] : stringArray(role.delegateTo, `role ${id}.delegateTo`, 16);
    delegateTo.forEach((target) => identifier(target, `role ${id}.delegateTo`));
    if (role.messaging !== undefined && typeof role.messaging !== "boolean") fail(`role ${id}.messaging must be boolean`);
    const runBudget = role.runBudget === undefined ? undefined : budget(role.runBudget, `role ${id}.runBudget`);
    roles[id] = { ...(model === undefined ? {} : { model }), ...(instructions === undefined ? {} : { instructions }),
      tools: tools as TeamToolName[], delegateTo, messaging: role.messaging ?? false,
      ...(runBudget === undefined ? {} : { runBudget }) };
  }
  for (const [id, role] of Object.entries(roles)) {
    for (const target of role.delegateTo) if (!Object.hasOwn(roles, target)) fail(`Unknown delegated role ${target} in role ${id}`);
  }
  const limits = plan.limits === undefined ? undefined : parseLimits(plan.limits);
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1 || plan.tasks.length > (limits?.maxTasks ?? 128)) fail("plan.tasks exceeds its task quota or is empty");
  const tasks = plan.tasks.map((value, index): TaskSpec => {
    const task = object(value, `task ${index}`, ["id", "agent", "input", "dependsOn"]);
    const id = identifier(task.id, "task id");
    const agent = identifier(task.agent, `task ${id}.agent`);
    if (!Object.hasOwn(roles, agent)) fail(`Unknown role ${agent} in task ${id}`);
    const input = text(task.input, `task ${id}.input`, 65_536);
    const dependsOn = task.dependsOn === undefined ? [] : stringArray(task.dependsOn, `task ${id}.dependsOn`, 128);
    dependsOn.forEach((dependency) => identifier(dependency, `task ${id} dependency`));
    return { id, agent, input, dependsOn };
  });
  validateGraph(tasks);
  const resultTaskId = identifier(plan.resultTaskId, "plan.resultTaskId");
  if (!tasks.some((task) => task.id === resultTaskId)) fail("plan.resultTaskId must identify a task");
  let checks: readonly TeamCheckSpec[];
  try { checks = plan.checks === undefined ? [] : parseTeamChecks(plan.checks); }
  catch (error) { fail(`plan.checks: ${error instanceof Error ? error.message : "Invalid checks"}`); }
  for (const check of checks) if (!tasks.some((task) => task.id === check.taskId)) fail(`Check ${check.id} references unknown task ${check.taskId}`);
  const result: TeamPlan = { format: 1, ...(name === undefined ? {} : { name }), roles, tasks, resultTaskId,
    ...(limits === undefined ? {} : { limits }), checks };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PLAN_BYTES) fail("Team plan exceeds 1 MiB");
  return freeze(result);
}

/** Read a bounded UTF-8 JSON file once; persist the returned plan instead of rereading on resume. */
export async function loadTeamPlan(path: string, options: { readonly mode?: TeamMode } = {}): Promise<TeamPlan> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_PLAN_BYTES) fail("Team plan must be a regular JSON file of at most 1 MiB");
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_PLAN_BYTES) fail("Team plan exceeds 1 MiB");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).replace(/^\uFEFF/u, "")); }
    catch { fail("Team plan must contain valid UTF-8 JSON"); }
    return parseTeamPlan(value, options);
  } finally { await file.close(); }
}

export function createTeamPreset(preset: TeamPreset, prompt: string, options: { readonly model?: string; readonly mode?: TeamMode } = {}): TeamPlan {
  if (!["supervisor", "pipeline", "parallel"].includes(preset)) fail(`Unknown team preset: ${preset}`);
  text(prompt, "team prompt", 32_768);
  const coding = options.mode === "coding";
  const worker = { ...(options.model === undefined ? {} : { model: options.model }), tools: coding ? [...READ_TOOLS, "write", "edit"] : READ_TOOLS,
    instructions: coding ? "Implement a bounded change in your own workspace copy. Run only configured checks. Submit evidence and a report; never claim source changes have been applied."
      : "Investigate independently using workspace evidence. Do not change files or claim unperformed tests. Submit findings, evidence, and limitations." };
  const final = { ...(options.model === undefined ? {} : { model: options.model }), tools: READ_TOOLS,
    delegateTo: preset === "supervisor" ? ["worker"] : [],
    instructions: "Synthesize the dependency reports, identify each task's contribution, and distinguish verified evidence from unverified claims. Dependency workspaces are not automatically merged. Do not wait for unsolicited messages." };
  const restriction = coding ? "Work only in your isolated copy; source application requires later human confirmation." : "Do not change files.";
  const tasks: TaskSpec[] = preset === "pipeline" ? [
    { id: "analysis", agent: "worker", input: `Inspect the request and produce evidence and a concrete ${coding ? "implementation" : "investigation"}. ${restriction}\n\nUser task:\n${prompt}` },
    { id: "review", agent: "worker", dependsOn: ["analysis"], input: `Review the analysis report for correctness, edge cases, and verification gaps. Your workspace is an independent baseline; no prior edits are present. ${restriction}\n\nUser task:\n${prompt}` },
    { id: "summary", agent: "supervisor", dependsOn: ["analysis", "review"], input: prompt },
  ] : [
    { id: "analysis", agent: "worker", input: `Investigate the user's task independently. Inspect relevant files and identify a concrete approach with evidence. ${restriction}\n\nUser task:\n${prompt}` },
    { id: "review", agent: "worker", input: `Independently review risks, edge cases, and validation needs. Inspect files and provide evidence. ${restriction}\n\nUser task:\n${prompt}` },
    { id: "summary", agent: "supervisor", dependsOn: ["analysis", "review"], input: prompt },
  ];
  return parseTeamPlan({ format: 1, name: preset, roles: { worker, supervisor: final }, tasks, resultTaskId: "summary",
    limits: { maxConcurrent: 2, maxTasks: 8, maxDepth: 2, maxTaskTurns: 4, maxDurationMs: 600_000,
      maxOutputBytes: 65_536, maxMessages: 24, maxMessageBytes: 8192 } }, { mode: options.mode ?? "read-only" });
}

function parseLimits(value: unknown): Partial<CoordinationLimits> {
  const record = object(value, "plan.limits", [...Object.keys(LIMIT_CAPS), "runBudget"]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "runBudget") { result[key] = budget(value, "plan.limits.runBudget"); continue; }
    const cap = LIMIT_CAPS[key as keyof typeof LIMIT_CAPS];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > cap) fail(`plan.limits.${key} must be an integer from 1 to ${cap}`);
    result[key] = value;
  }
  return result as Partial<CoordinationLimits>;
}

function budget(value: unknown, label: string): RunBudget {
  object(value, label);
  try { return resolveRunBudget(value as RunBudget); }
  catch (error) { fail(`${label}: ${error instanceof Error ? error.message : "Invalid Run budget"}`); }
}

function validateGraph(tasks: readonly TaskSpec[]): void {
  const pending = new Map(tasks.map((task) => [task.id, task]));
  if (pending.size !== tasks.length) fail("Duplicate task id");
  for (const task of tasks) for (const id of task.dependsOn ?? []) if (!pending.has(id)) fail(`Unknown dependency ${id} in task ${task.id}`);
  while (pending.size) {
    let progress = false;
    for (const [id, task] of pending) {
      if (task.dependsOn?.some((dependency) => pending.has(dependency))) continue;
      pending.delete(id); progress = true;
    }
    if (!progress) fail("Task dependencies contain a cycle");
  }
}

function object(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`Unknown ${label} field: ${key}`);
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) fail(`${label} must be a non-reserved 1-128 character ASCII identifier`);
  return value;
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) fail(`${label} must be nonempty text of at most ${maxBytes} bytes without NUL`);
  return value;
}

function stringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) fail(`${label} must be an array of at most ${max} unique strings`);
  return [...value] as string[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function fail(message: string): never { throw new MaybeCodeUsageError(message); }
