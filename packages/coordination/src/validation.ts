import { resolveRunBudget } from "@sortedyuan/may/core";
import type { CoordinationLimits, HandoffSpec, TaskMessageSpec, TaskOutput, TaskSpec } from "./types.js";

export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function name(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} must be 1-128 ASCII letters, digits, dots, underscores or hyphens`);
  }
}

export function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${label} must be a positive safe integer`);
}

export function limits(options: Partial<CoordinationLimits> = {}): CoordinationLimits {
  const result = {
    maxConcurrent: 4,
    maxTasks: 128,
    maxOutputBytes: 65_536,
    maxInputBytes: 65_536,
    maxDepth: 4,
    maxTaskTurns: 16,
    maxMessages: 1024,
    maxMessageBytes: 16_384,
    maxHandoffs: 4,
    maxHandoffBytes: 16_384,
    maxAttempts: 3,
    maxGraphChanges: 32,
    ...options,
  };
  for (const key of [
    "maxConcurrent",
    "maxTasks",
    "maxOutputBytes",
    "maxInputBytes",
    "maxDepth",
    "maxTaskTurns",
    "maxMessages",
    "maxMessageBytes",
    "maxHandoffs",
    "maxHandoffBytes",
    "maxAttempts",
    "maxGraphChanges",
  ] as const)
    positive(result[key], key);
  if (result.maxDurationMs !== undefined) {
    positive(result.maxDurationMs, "maxDurationMs");
    if (result.maxDurationMs > 2_147_483_647) throw new RangeError("maxDurationMs exceeds the timer limit");
  }
  return freeze({
    ...result,
    ...(result.runBudget === undefined ? {} : { runBudget: resolveRunBudget(result.runBudget) }),
  });
}

export function validateGraph(tasks: readonly TaskSpec[], maxTasks: number, maxInputBytes = 65_536): void {
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > maxTasks)
    throw new Error(`Expected 1-${maxTasks} tasks`);
  const nodes = new Map<string, TaskSpec>();
  for (const task of tasks) {
    name(task.id, "task id");
    name(task.agent, "agent name");
    if (typeof task.input !== "string") throw new TypeError("Task input must be a string");
    if (Buffer.byteLength(task.input, "utf8") > maxInputBytes) throw new Error("Task input exceeds maxInputBytes");
    validateTaskFiles(task.files);
    if (nodes.has(task.id)) throw new Error(`Duplicate task: ${task.id}`);
    if (
      task.dependsOn !== undefined &&
      (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length)
    )
      throw new Error(`Invalid dependencies: ${task.id}`);
    nodes.set(task.id, task);
  }
  const pending = new Set(nodes.keys());
  while (pending.size > 0) {
    let progress = false;
    for (const id of pending) {
      const deps = nodes.get(id)!.dependsOn ?? [];
      if (deps.some((dep) => !nodes.has(dep))) throw new Error(`Unknown dependency: ${id}`);
      if (deps.some((dep) => pending.has(dep))) continue;
      pending.delete(id);
      progress = true;
    }
    if (!progress) throw new Error("Task dependencies contain a cycle");
  }
}

/**
 * 工作区相对、长度有界、不含上级目录的任务文件声明，适用于共享工作区。
 * @experimental
 */
export function validateTaskFiles(files: readonly string[] | undefined): void {
  if (files === undefined) return;
  if (!Array.isArray(files) || files.length > 128) throw new TypeError("Task files must contain at most 128 paths");
  const seen = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || file.length > 512 || file.includes("\0"))
      throw new TypeError("Task file paths must be nonempty strings of at most 512 characters");
    const path = file.replace(/\\/gu, "/");
    if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.split("/").some((part) => part === ".."))
      throw new Error(`Task file path must be workspace-relative: ${file}`);
    if (seen.has(path)) throw new Error(`Duplicate task file: ${file}`);
    seen.add(path);
  }
}

export function validateOutput(value: TaskOutput, maxBytes: number): TaskOutput {
  if (value === null || typeof value !== "object" || typeof value.text !== "string")
    throw new TypeError("Task output must contain text");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes)
    throw new Error("Task output exceeds maxOutputBytes");
  return copy(value);
}

export function validateMessage(value: TaskMessageSpec, maxBytes: number): void {
  if (!value || typeof value !== "object") throw new TypeError("Message must be an object");
  name(value.toTaskId, "recipient task id");
  if (typeof value.text !== "string" || value.text.length === 0) throw new TypeError("Message text must be nonempty");
  if (Buffer.byteLength(value.text, "utf8") > maxBytes) throw new Error("Message text exceeds maxMessageBytes");
}

export function validateHandoff(value: HandoffSpec, maxBytes: number): void {
  if (!value || typeof value !== "object") throw new TypeError("Handoff must be an object");
  name(value.agent, "handoff agent");
  if (typeof value.input !== "string" || !value.input.length) throw new TypeError("Handoff input must be nonempty");
  if (Buffer.byteLength(value.input, "utf8") > maxBytes) throw new Error("Handoff input exceeds maxHandoffBytes");
}
