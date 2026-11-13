import type { CoordinationAgent, TaskRecovery } from "./types.js";
import { dispatchId, validateOutcome, validateToken, type JobView } from "./remote-protocol.js";
import { name, positive } from "./validation.js";

/** @experimental */
export interface RemoteAgentOptions {
  readonly url: string;
  readonly token: string;
  readonly agent: string;
  readonly version: string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Independent remote worker adapter. The coordinator keeps graph ownership and recovery policy.
 * @experimental
 */
export function createRemoteAgent(options: RemoteAgentOptions): CoordinationAgent {
  options = { ...options };
  validateToken(options.token);
  name(options.agent, "remote agent");
  name(options.version, "remote version");
  const base = new URL(options.url);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  )
    throw new Error("Remote worker requires an HTTPS origin except on loopback; credentials belong in token options");
  const timeout = options.requestTimeoutMs ?? 20_000,
    interval = options.pollIntervalMs ?? 250,
    maxBytes = options.maxResponseBytes ?? 2_097_152;
  for (const value of [timeout, interval, maxBytes]) positive(value, "remote limit");
  const active = new Map<string, string>();
  const request = async (path: string, value?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(new URL(path, base), {
      method: value === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Remote worker rejected request (${response.status}); execution was not retried`);
    }
    if (!response.body) throw new Error("Missing remote response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > maxBytes) throw new Error("Remote response exceeds limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  return {
    version: options.version,
    async execute(execution, context) {
      context.signal.throwIfAborted();
      const id = dispatchId(execution);
      let cursor = 0;
      active.set(execution.task.sessionId, id);
      try {
        let view = (await request("/v1/jobs", { agent: options.agent, execution }, context.signal)) as JobView;
        while (true) {
          if (view.id !== id || !Array.isArray(view.events) || !["queued", "running", "terminal"].includes(view.status))
            throw new Error("Invalid remote job response");
          for (const item of view.events)
            if (item.seq > cursor) {
              context.report(item.event);
              cursor = item.seq;
            }
          if (view.status === "terminal") {
            const outcome = validateOutcome(view.outcome!);
            if (outcome.status === "completed") return outcome.output;
            throw new Error("Remote execution requires outcome reconciliation");
          }
          await pause(interval, context.signal);
          view = (await request(`/v1/jobs/${id}?after=${cursor}`, undefined, context.signal)) as JobView;
        }
      } catch (error) {
        if (context.signal.aborted)
          await request("/v1/cancel", { agent: options.agent, execution }).catch(() => undefined);
        throw error;
      } finally {
        active.delete(execution.task.sessionId);
      }
    },
    async recover(execution) {
      try {
        if (execution.task.cancelRequested) await request("/v1/cancel", { agent: options.agent, execution });
        return validateOutcome((await request("/v1/recover", { agent: options.agent, execution })) as TaskRecovery);
      } catch {
        return { status: "recovery-required", detail: "Remote outcome unavailable; do not re-dispatch or replay" };
      }
    },
    async cancel(execution) {
      await request("/v1/cancel", { agent: options.agent, execution });
    },
    async resolveApproval(sessionId, requestId, decision) {
      const id = active.get(sessionId);
      if (!id) return false;
      return (
        ((await request(`/v1/jobs/${id}/approval`, { requestId, decision })) as { accepted: boolean }).accepted === true
      );
    },
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
