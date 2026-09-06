import { randomUUID } from "node:crypto";
import { AsyncEventQueue } from "@may/core";
import { specTypeSchemas, type ElicitRequestFormParams, type ElicitResult, type JsonSchemaType, type JsonSchemaValidator } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { McpCapabilityError } from "./errors.js";

/** Supplied by trusted host code, never by the server, model, or MCP _meta. */
export interface McpInteractionOwner {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly toolCallId?: string;
}

export type McpElicitationParams = ElicitRequestFormParams | { readonly mode: "url"; readonly message: string; readonly url: string };

export interface McpInteractionRequest {
  readonly id: string;
  readonly serverId: string;
  readonly requestId: string;
  readonly owner: McpInteractionOwner;
  readonly expiresAt: number;
  readonly params: McpElicitationParams;
}

export type McpInteractionEvent =
  | { readonly type: "mcp.interaction.requested"; readonly request: McpInteractionRequest }
  | { readonly type: "mcp.interaction.settled"; readonly requestId: string; readonly reason: "answered" | "cancelled" };

interface Pending {
  readonly request: McpInteractionRequest;
  readonly validate?: JsonSchemaValidator<unknown>;
  finish(response?: ElicitResult): void;
}

/** Ephemeral, bounded UI rendezvous. Answers never enter Session history or traces here. */
export class McpInteractionBroker {
  private readonly queue = new AsyncEventQueue<McpInteractionEvent>({ maxBufferedValues: 128, isDroppable: () => true });
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  readonly events: AsyncIterable<McpInteractionEvent> = this.queue;

  list(owner: Pick<McpInteractionOwner, "workspaceId" | "sessionId">): readonly McpInteractionRequest[] {
    return Object.freeze([...this.pending.values()].map((entry) => entry.request).filter((request) => sameSession(request.owner, owner)));
  }

  async request(serverId: string, requestId: string, owner: McpInteractionOwner, raw: unknown, signal: AbortSignal, expiresAt: number): Promise<ElicitResult> {
    signal.throwIfAborted();
    if (this.closed || this.pending.size >= 32 || expiresAt <= Date.now()) return Promise.reject(failure(serverId, "interaction unavailable or expired"));
    if (!owner.workspaceId || !owner.sessionId) return Promise.reject(failure(serverId, "interaction has no trusted workspace/session owner"));
    bounded(raw, serverId);
    let params: McpElicitationParams;
    if (raw !== null && typeof raw === "object" && "mode" in raw && raw.mode === "url") {
      const url = raw as { url?: unknown; message?: unknown };
      if (typeof url.url !== "string" || typeof url.message !== "string") throw failure(serverId, "invalid URL elicitation request");
      // The shared legacy SDK schema requires elicitationId; modern URL mode
      // deliberately removed that field. No synthetic server id is invented.
      params = { mode: "url", url: url.url, message: url.message };
    } else {
      const parsed = await specTypeSchemas.ElicitRequestFormParams["~standard"].validate(raw);
      if (parsed.issues !== undefined) throw failure(serverId, "invalid elicitation request");
      params = { mode: "form", message: parsed.value.message, requestedSchema: structuredClone(parsed.value.requestedSchema) };
    }
    signal.throwIfAborted();
    if (this.closed || this.pending.size >= 32) throw failure(serverId, "interaction unavailable");
    if (params.message.length > 4096) throw failure(serverId, "elicitation message exceeds host limit");
    let validate: JsonSchemaValidator<unknown> | undefined;
    if (params.mode === "url") {
      const url = new URL(params.url);
      // Never navigate, fetch, forward credentials, or treat consent as completion.
      if (url.protocol !== "https:" || url.username || url.password || params.url.length > 8192 || /[\u0000-\u0020\u007f]/u.test(params.url)) throw failure(serverId, "elicitation URL must be credential-free HTTPS");
    } else {
      const original = (raw as { requestedSchema: Record<string, unknown> }).requestedSchema;
      checkFormSchema(original, serverId);
      // Validate the original bounded schema, not a schema with silently stripped constraints.
      params.requestedSchema = structuredClone(original) as typeof params.requestedSchema;
      try { validate = new AjvJsonSchemaValidator().getValidator({ ...params.requestedSchema, additionalProperties: false } as JsonSchemaType); }
      catch { throw failure(serverId, "invalid elicitation form schema"); }
    }
    const request = freezeTree({ id: randomUUID(), serverId, requestId, owner: { ...owner }, expiresAt, params });
    return new Promise((resolve, reject) => {
      const abort = () => entry.finish();
      const timer = setTimeout(abort, Math.min(expiresAt - Date.now(), 2_147_483_647));
      const entry: Pending = {
        request, ...(validate === undefined ? {} : { validate }),
        finish: (response) => {
          if (!this.pending.delete(request.id)) return;
          clearTimeout(timer); signal.removeEventListener("abort", abort);
          this.queue.push({ type: "mcp.interaction.settled", requestId: request.id, reason: response === undefined ? "cancelled" : "answered" });
          if (response === undefined) reject(failure(serverId, "interaction cancelled or expired"));
          else resolve(response);
        },
      };
      this.pending.set(request.id, entry);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.queue.push({ type: "mcp.interaction.requested", request });
    });
  }

  respond(id: string, owner: McpInteractionOwner, response: ElicitResult): boolean {
    const pending = this.pending.get(id);
    if (pending === undefined) return false;
    const { request } = pending;
    if (!sameSession(request.owner, owner) || request.owner.runId !== owner.runId || request.owner.toolCallId !== owner.toolCallId) return false;
    if (request.expiresAt <= Date.now()) { pending.finish(); return false; }
    bounded(response, request.serverId);
    if (!["accept", "decline", "cancel"].includes(response?.action)) throw failure(request.serverId, "invalid elicitation action");
    if (response.action !== "accept" || request.params.mode === "url") {
      if (response.content !== undefined) throw failure(request.serverId, "this response must not contain form content");
      pending.finish({ action: response.action });
    } else {
      if (!pending.validate?.(response.content).valid) throw failure(request.serverId, "form response does not match requested schema");
      pending.finish({ action: "accept", content: structuredClone(response.content!) });
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.finish();
    this.queue.close();
  }
}

function failure(serverId: string, message: string): McpCapabilityError {
  return new McpCapabilityError(serverId, message, "MCP_INTERACTION_ERROR");
}
function bounded(value: unknown, serverId: string): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 64 * 1024) throw failure(serverId, "interaction exceeds 64 KiB limit");
}
function sameSession(a: McpInteractionOwner, b: Pick<McpInteractionOwner, "workspaceId" | "sessionId">): boolean {
  return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freezeTree); Object.freeze(value); }
  return value;
}

function checkFormSchema(schema: Record<string, unknown>, serverId: string): void {
  // No external refs, arbitrary regexes, recursive schemas, or executable validators.
  const allowed = new Set(["type", "title", "description", "default", "properties", "required", "minLength", "maxLength", "format", "minimum", "maximum", "enum", "enumNames", "oneOf", "const", "minItems", "maxItems", "items", "anyOf"]);
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8) throw failure(serverId, "form schema is too deep");
    if (Array.isArray(value)) { if (value.length > 128) throw failure(serverId, "form schema array exceeds host limit"); value.forEach((item) => walk(item, depth + 1)); }
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!allowed.has(key)) throw failure(serverId, "unsupported form schema keyword");
        if (key === "properties") {
          const fields = Object.entries(item as object);
          if (fields.length > 32 || fields.some(([name]) => ["__proto__", "constructor", "prototype"].includes(name))) throw failure(serverId, "invalid form fields or too many fields");
          fields.forEach(([, field]) => walk(field, depth + 1));
        } else walk(item, depth + 1);
      }
    }
  };
  walk(schema, 0);
}
