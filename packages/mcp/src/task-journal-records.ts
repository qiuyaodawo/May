import type { McpInteractionOwner } from "./interactions.js";
import type { McpTaskBinding, McpTaskRecord } from "./task-journal.js";
import { integer, object, parseMcpTask, taskFailure, text } from "./tasks.js";

export type SessionOwner = Pick<McpInteractionOwner, "workspaceId" | "sessionId">;

export function validateRecord(value: unknown, owner: SessionOwner): asserts value is McpTaskRecord {
  if (!object(value) || value.version !== 1 || !uuid(value.id) || !object(value.owner) || !object(value.binding))
    throw new Error();
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "id",
          "owner",
          "binding",
          "createdAt",
          "updatedAt",
          "status",
          "remote",
          "cancellation",
          "inputs",
          "samplingCalls",
          "samplingTokens",
          "initialUsage",
          "inputAttempts",
        ].includes(key),
    )
  )
    throw new Error();
  validOwner(value.owner as unknown as McpInteractionOwner);
  validBinding(value.binding as unknown as McpTaskBinding);
  if (
    value.owner.workspaceId !== owner.workspaceId ||
    value.owner.sessionId !== owner.sessionId ||
    !integer(value.createdAt, 0) ||
    !integer(value.updatedAt, value.createdAt)
  )
    throw new Error();
  if (
    !["starting", "uncertain", "working", "input_required", "completed", "cancelled", "failed"].includes(
      value.status as string,
    )
  )
    throw new Error();
  if (value.remote !== undefined) {
    if (
      !object(value.remote) ||
      "statusMessage" in value.remote ||
      Object.keys(value.remote).some(
        (key) => !["taskId", "status", "createdAt", "lastUpdatedAt", "ttlMs", "pollIntervalMs"].includes(key),
      )
    )
      throw new Error();
    const remote = parseMcpTask({ ...value.remote, resultType: "task" }, "created", value.binding.serverId as string);
    if (remote.status !== value.status) throw new Error();
  } else if (!["starting", "uncertain"].includes(value.status as string)) throw new Error();
  if (
    value.cancellation !== undefined &&
    (!["requested", "acknowledged"].includes(value.cancellation as string) || value.remote === undefined)
  )
    throw new Error();
  if (
    !integer(value.samplingCalls, 0) ||
    value.samplingCalls > 4 ||
    !integer(value.samplingTokens, 0) ||
    value.samplingTokens > 16_384 ||
    !object(value.inputs) ||
    Object.keys(value.inputs).length > 32
  )
    throw new Error();
  const claims = new Set<string>();
  for (const [key, claim] of Object.entries(value.inputs)) {
    if (
      !hash(key) ||
      !object(claim) ||
      !uuid(claim.id) ||
      claims.has(claim.id) ||
      !hash(claim.fingerprint) ||
      !["claimed", "submitted", "acknowledged", "abandoned"].includes(claim.state as string) ||
      (claim.samplingReserved !== undefined && claim.samplingReserved !== true) ||
      (claim.expiresAt !== undefined && !integer(claim.expiresAt, 0)) ||
      (claim.samplingReservations !== undefined &&
        (!integer(claim.samplingReservations, claim.samplingReserved ? 1 : 0) || claim.samplingReservations > 4)) ||
      Object.keys(claim).some(
        (key) => !["id", "fingerprint", "state", "samplingReserved", "samplingReservations", "expiresAt"].includes(key),
      )
    )
      throw new Error();
    claims.add(claim.id);
  }
  const initial = value.initialUsage;
  if (
    initial !== undefined &&
    (!object(initial) ||
      !integer(initial.inputs, 0) ||
      initial.inputs + Object.keys(value.inputs).length > 32 ||
      !integer(initial.samplingCalls, 0) ||
      initial.samplingCalls > 4 ||
      !integer(initial.samplingTokens, 0) ||
      initial.samplingTokens > initial.samplingCalls * 4096)
  )
    throw new Error();
  if (
    value.inputAttempts !== undefined &&
    (!integer(value.inputAttempts, Object.keys(value.inputs).length) ||
      value.inputAttempts + ((initial as { inputs: number } | undefined)?.inputs ?? 0) > 32)
  )
    throw new Error();
  if (
    Object.values(value.inputs).reduce<number>((total, raw) => {
      const claim = raw as Record<string, unknown>;
      return total + ((claim.samplingReservations as number | undefined) ?? (claim.samplingReserved ? 1 : 0));
    }, 0) +
      ((initial as { samplingCalls: number } | undefined)?.samplingCalls ?? 0) !==
      value.samplingCalls ||
    value.samplingTokens <
      ((initial as { samplingTokens: number } | undefined)?.samplingTokens ?? 0) +
        value.samplingCalls -
        ((initial as { samplingCalls: number } | undefined)?.samplingCalls ?? 0) ||
    value.samplingTokens > value.samplingCalls * 4096
  )
    throw new Error();
}
export function validOwner(owner: SessionOwner): void {
  if (
    !object(owner) ||
    !text(owner.workspaceId, 4096) ||
    !text(owner.sessionId, 1024) ||
    Object.keys(owner).some((key) => !["workspaceId", "sessionId", "runId", "toolCallId"].includes(key)) ||
    Object.entries(owner).some(([, value]) => !text(value, 4096))
  )
    throw taskFailure("journal", "invalid trusted task owner");
}
export function validBinding(binding: McpTaskBinding): void {
  if (
    !object(binding) ||
    binding.protocolVersion !== "2026-07-28" ||
    !text(binding.serverId, 128) ||
    !text(binding.toolName, 1024) ||
    !hash(binding.endpointIdentity) ||
    !hash(binding.toolDefinitionHash) ||
    Object.keys(binding).some(
      (key) => !["serverId", "protocolVersion", "toolName", "endpointIdentity", "toolDefinitionHash"].includes(key),
    )
  )
    throw taskFailure("journal", "invalid trusted task binding");
}
export function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}
