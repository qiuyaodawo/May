import { DateTime } from "luxon";
import type { CreateJobInput, ExecutionQuery, SchedulerEvent, UpdateJobInput } from "./types.js";
import { validateTrigger } from "./triggers.js";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("Expected a plain object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new TypeError(`Unknown field: ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Fields must be enumerable data properties");
  }
  return value as Record<string, unknown>;
}

export function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Identifier must contain 1-256 characters without control characters");
  }
}

export function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("Revision must be a positive safe integer");
}

export function validateTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.indexOf("T") < 1 || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !DateTime.fromISO(value, { setZone: true }).isValid) {
    throw new TypeError("Timestamp must be an ISO date-time with an explicit UTC offset");
  }
}

/** JSON 编解码前验证内容，防止 JSON.stringify 丢弃非法字段。 */
export function cloneJson<T>(value: T, maxDepth = 128): T {
  const ancestors = new Set<object>();
  function validate(item: unknown, depth: number): void {
    if (depth > maxDepth) throw new RangeError(`JSON nesting must not exceed ${maxDepth} levels`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null) throw new TypeError("Only finite JSON values are supported");
    if (ancestors.has(item)) throw new TypeError("JSON values cannot contain cycles");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1) throw new TypeError("JSON arrays cannot contain holes or extra properties");
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("JSON arrays require data properties");
        validate(descriptor.value, depth + 1);
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError("JSON objects must have the plain object prototype");
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("JSON objects require string data properties");
        validate(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  validate(value, 0);
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

export function validateStoredJson<T>(value: T): T {
  const copied = cloneJson(value, 64);
  if (Buffer.byteLength(JSON.stringify(copied)) > 1024 * 1024) throw new RangeError("Stored JSON value must not exceed 1 MiB");
  return copied;
}

function validatePayload(value: unknown): void {
  const copied = cloneJson(value, 60);
  if (Buffer.byteLength(JSON.stringify(copied)) > 64 * 1024) throw new RangeError("Task or event payload must not exceed 64 KiB");
}

function validateTask(value: unknown): void {
  const task = object(value, ["handler", "payload"]);
  validateId(task.handler);
  validatePayload(task.payload);
}

function validateMisfire(value: unknown): void {
  const policy = object(value, ["policy", "graceMs"]);
  if (typeof policy.policy !== "string" || !["skip", "latest"].includes(policy.policy) || !Number.isSafeInteger(policy.graceMs) || (policy.graceMs as number) < 0) {
    throw new TypeError("Misfire requires skip/latest and non-negative safe integer graceMs");
  }
}

export function validateJobInput(input: CreateJobInput): void {
  object(input, ["id", "enabled", "trigger", "task", "misfire"]);
  validateId(input.id);
  if (typeof input.enabled !== "boolean") throw new TypeError("Job enabled must be boolean");
  validateTrigger(input.trigger);
  validateTask(input.task);
  validateMisfire(input.misfire);
  validateStoredJson(input);
}

export function validateJobUpdate(input: UpdateJobInput): void {
  object(input, ["enabled", "trigger", "task", "misfire"]);
  if (Object.keys(input).length === 0) throw new TypeError("Job update must contain at least one field");
  if ("enabled" in input && typeof input.enabled !== "boolean") throw new TypeError("Job enabled must be boolean");
  if ("trigger" in input) validateTrigger(input.trigger!);
  if ("task" in input) validateTask(input.task);
  if ("misfire" in input) validateMisfire(input.misfire);
}

export function validateEvent(input: SchedulerEvent): void {
  object(input, ["source", "id", "topic", "occurredAt", "payload"]);
  validateId(input.source);
  validateId(input.id);
  validateId(input.topic);
  validateTimestamp(input.occurredAt);
  validatePayload(input.payload);
  validateStoredJson(input);
}

export function validateExecutionQuery(query: ExecutionQuery): void {
  object(query, ["jobId", "status", "afterSeq", "limit"]);
  if ("jobId" in query) validateId(query.jobId);
  if ("status" in query && !["pending", "dispatching", "submitted", "failed", "skipped"].includes(query.status!)) throw new TypeError("Invalid execution status");
  if ("afterSeq" in query && (!Number.isSafeInteger(query.afterSeq) || query.afterSeq! < 0)) throw new TypeError("afterSeq must be a non-negative safe integer");
  if ("limit" in query && (!Number.isSafeInteger(query.limit) || query.limit! < 1 || query.limit! > 1000)) throw new TypeError("limit must be 1-1000");
}
