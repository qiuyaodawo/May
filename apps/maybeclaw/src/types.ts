import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolveRunBudget, type RunBudget } from "@may/core";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "blocked";

/** Local, single-owner product contract. No chat/channel identity is inferred here. */
export interface TaskSpec {
  readonly requestId: string;
  readonly prompt: string;
  readonly configPath: string;
  readonly modelProfile: string;
  readonly modelFingerprint: string;
  readonly readDirectory?: string;
  readonly runBudget: RunBudget;
}

export interface TaskSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly spec: TaskSpec;
  readonly status: TaskStatus;
  /** A completed model response is not independently verified task success. */
  readonly verification: "unverified";
  readonly result?: string;
  readonly detail?: string;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function taskId(requestId: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(requestId)) throw new Error("requestId must be 1-128 letters, digits, dots, underscores, colons or hyphens");
  return digest({ product: "maybeclaw-v1", requestId });
}

export function validateId(id: string): void {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid MaybeClaw task id");
}

export function validateSpec(spec: TaskSpec): void {
  if (!spec || typeof spec !== "object") throw new Error("Invalid task specification");
  taskId(spec.requestId);
  if (typeof spec.prompt !== "string" || !spec.prompt.trim() || Buffer.byteLength(spec.prompt) > 65_536) throw new Error("Task prompt must be non-empty and at most 64 KiB");
  if (typeof spec.configPath !== "string" || !isAbsolute(spec.configPath)) throw new Error("Task configPath must be absolute");
  if (typeof spec.modelProfile !== "string" || !spec.modelProfile || spec.modelProfile.length > 256) throw new Error("Invalid task model profile");
  if (!/^[a-f0-9]{64}$/u.test(spec.modelFingerprint)) throw new Error("Invalid model fingerprint");
  if (spec.readDirectory !== undefined && (typeof spec.readDirectory !== "string" || !isAbsolute(spec.readDirectory))) throw new Error("readDirectory must be absolute");
  if (!spec.runBudget || typeof spec.runBudget !== "object") throw new Error("Task requires a run budget");
  resolveRunBudget(spec.runBudget);
  for (const key of ["maxDurationMs", "maxSteps", "maxModelCalls", "maxToolCalls"] as const) {
    if (spec.runBudget[key] === undefined) throw new Error(`Task requires ${key}`);
  }
}

export function validateSnapshot(value: TaskSnapshot, id: string): void {
  if (!value || value.version !== 1 || value.id !== id || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || !["queued", "running", "completed", "failed", "cancelled", "blocked"].includes(value.status)
    || value.verification !== "unverified") throw new Error("Invalid task journal record");
  validateSpec(value.spec);
  if (taskId(value.spec.requestId) !== id) throw new Error("Task identity mismatch");
  if (value.status === "completed" ? typeof value.result !== "string" : value.result !== undefined) throw new Error("Invalid task result");
  if (value.detail !== undefined && (typeof value.detail !== "string" || value.detail.length > 4096)) throw new Error("Invalid task detail");
}

export function isTerminal(task: TaskSnapshot): boolean {
  return ["completed", "failed", "cancelled"].includes(task.status);
}
