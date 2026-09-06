import { McpCapabilityError } from "./errors.js";
import { assertMcpContentSize } from "./content.js";

/** The 2026-07-28 extension, not the incompatible 2025 experimental Tasks API. */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export type McpTaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";

export interface McpRemoteTask {
  readonly taskId: string;
  readonly status: McpTaskStatus;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
  readonly statusMessage?: string;
}

export type McpTaskState = McpRemoteTask & (
  | { readonly status: "working" | "cancelled" }
  | { readonly status: "input_required"; readonly inputRequests: Readonly<Record<string, unknown>> }
  | { readonly status: "completed"; readonly result: Readonly<Record<string, unknown>> }
  | { readonly status: "failed"; readonly error: Readonly<Record<string, unknown>> }
);

/**
 * Validate extension-native frames before trusting an id/state. Does not turn a
 * task's result into tool content or fulfill its input requests. Those require
 * the originating tool schema, host services and permission/ownership checks.
 */
export function parseMcpTask(value: unknown, kind: "created", serverId: string): McpRemoteTask;
export function parseMcpTask(value: unknown, kind: "state", serverId: string): McpTaskState;
export function parseMcpTask(value: unknown, kind: "created" | "state", serverId: string): McpRemoteTask | McpTaskState {
  try {
    assertMcpContentSize(value);
    if (!object(value) || value.resultType !== (kind === "created" ? "task" : "complete")) throw new Error();
    if (!text(value.taskId, 1024) || !["working", "input_required", "completed", "cancelled", "failed"].includes(value.status as string)) throw new Error();
    const createdAt = timestamp(value.createdAt);
    const updatedAt = timestamp(value.lastUpdatedAt);
    if (createdAt === undefined || updatedAt === undefined || updatedAt < createdAt) throw new Error();
    if (value.ttlMs !== null && !integer(value.ttlMs, 0)) throw new Error();
    if (value.pollIntervalMs !== undefined && !integer(value.pollIntervalMs, 0)) throw new Error();
    if (value.statusMessage !== undefined && (typeof value.statusMessage !== "string" || value.statusMessage.length > 4096)) throw new Error();
    const base: McpRemoteTask = {
      taskId: value.taskId, status: value.status as McpTaskStatus,
      createdAt: value.createdAt as string, lastUpdatedAt: value.lastUpdatedAt as string,
      ttlMs: value.ttlMs as number | null,
      ...(value.pollIntervalMs === undefined ? {} : { pollIntervalMs: value.pollIntervalMs as number }),
      ...(value.statusMessage === undefined ? {} : { statusMessage: value.statusMessage as string }),
    };
    if (kind === "created") return Object.freeze(base);
    if (value.status === "input_required") {
      if (!object(value.inputRequests) || Object.keys(value.inputRequests).length === 0 || Object.keys(value.inputRequests).length > 32 ||
          Object.keys(value.inputRequests).some((key) => !text(key, 1024))) throw new Error();
      if (Buffer.byteLength(JSON.stringify(value.inputRequests)) > 64 * 1024) throw new Error();
      return freezeTree({ ...base, status: "input_required", inputRequests: structuredClone(value.inputRequests) });
    }
    if (value.status === "completed") {
      if (!object(value.result) || value.result.resultType !== undefined && value.result.resultType !== "complete") throw new Error();
      return freezeTree({ ...base, status: "completed", result: structuredClone(value.result) });
    }
    if (value.status === "failed") {
      if (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string" || value.error.message.length > 4096) throw new Error();
      return freezeTree({ ...base, status: "failed", error: structuredClone(value.error) });
    }
    return Object.freeze({ ...base, status: value.status as "working" | "cancelled" });
  } catch { throw taskFailure(serverId, "invalid or oversized task extension response"); }
}

export function taskFailure(serverId: string, message: string): McpCapabilityError {
  return new McpCapabilityError(serverId, message, "MCP_TASK_ERROR");
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)) return undefined;
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}
export function freezeTree<T>(value: T): T {
  if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}
