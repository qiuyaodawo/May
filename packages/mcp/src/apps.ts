import { randomUUID } from "node:crypto";
import type { ToolExecutor } from "@may/core";
import type { Tool, ReadResourceResult } from "@modelcontextprotocol/client";
import { McpCapabilityError } from "./errors.js";
import { assertMcpContentSize } from "./content.js";
import { freezeTree, object } from "./tasks.js";
import type { McpInteractionOwner } from "./interactions.js";
import type { McpOperationOptions, McpToolOutput } from "./types.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export interface McpAppsHostOptions {
  /** The host's normal permission executor, never a renderer-supplied executor. */
  readonly executor: ToolExecutor;
  /** Explicit consent for opening HTML and each resource read; deny by default. */
  readonly approve: (request: { readonly kind: "open" | "read"; readonly serverId: string; readonly uri: string;
    readonly owner: McpInteractionOwner; readonly signal: AbortSignal }) => Promise<boolean>;
}
export interface McpAppOpenOptions extends McpOperationOptions {
  readonly owner: McpInteractionOwner;
  /** Ephemeral view lifetime; defaults to ten minutes, maximum one hour. */
  readonly lifetimeMs?: number;
}
export interface McpAppResource { readonly uri: string; readonly html: string }

/** Visibility is enforced even in terminal hosts that do not advertise Apps. */
export function mcpToolVisibility(tool: Tool, audience: "model" | "app"): boolean {
  const ui = tool._meta?.ui;
  if (ui === undefined) return true;
  if (!object(ui)) return false;
  const visibility = ui.visibility;
  return visibility === undefined || Array.isArray(visibility) && visibility.length <= 2 &&
    visibility.every((entry) => entry === "app" || entry === "model") && visibility.includes(audience);
}
export function mcpAppUri(tool: Tool): string | undefined {
  const ui = tool._meta?.ui;
  const value = object(ui) ? ui.resourceUri : undefined;
  return typeof value === "string" && value.startsWith("ui://") && value.length <= 2048 && !/[\u0000-\u0020\u007f]/u.test(value) ? value : undefined;
}
export function parseMcpAppResource(uri: string, result: ReadResourceResult): McpAppResource {
  assertMcpContentSize(result);
  const item = result.contents[0];
  if (result.contents.length !== 1 || item?.uri !== uri || item.mimeType !== MCP_APP_MIME) throw appError();
  let html: string;
  if ("text" in item && typeof item.text === "string" && !("blob" in item)) html = item.text;
  else if ("blob" in item && typeof item.blob === "string" && !("text" in item)) {
    const bytes = Buffer.from(item.blob, "base64");
    if (bytes.toString("base64") !== item.blob) throw appError();
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else throw appError();
  if (Buffer.byteLength(html) > 2 * 1024 * 1024 || !/^\s*<!doctype html[\s>]/iu.test(html)) throw appError();
  // The supplied sandbox deliberately grants NO remote domains or device permissions.
  // Server CSP/domain/permissions metadata cannot loosen this host policy.
  return freezeTree({ uri, html });
}

interface AppOperations {
  readonly guard: () => Promise<void>;
  readonly call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpToolOutput>;
  readonly read: (uri: string, signal: AbortSignal) => Promise<ReadResourceResult>;
}

/** Backend-owned, single owner/connection view. Never send this object to untrusted code. */
export class McpAppSession {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private initialized = false;
  private ready = false;
  private readonly seen = new Set<string>();
  private active = 0;
  constructor(readonly resource: McpAppResource, private readonly tool: Tool, private readonly operations: AppOperations, signal: AbortSignal) {
    this.signal = AbortSignal.any([this.controller.signal, signal]);
  }
  close(): void { this.controller.abort("MCP App closed"); }

  /** One JSON-RPC message from the authenticated, source-checked renderer channel. */
  async receive(raw: unknown): Promise<Record<string, unknown> | undefined> {
    let id: string | number | undefined;
    let counted = false;
    try {
      assertMcpContentSize(raw);
      if (!object(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string" || Buffer.byteLength(JSON.stringify(raw)) > 256 * 1024) throw appError();
      if (raw.id !== undefined) {
        if (!(typeof raw.id === "string" && raw.id.length <= 256 || Number.isSafeInteger(raw.id))) throw appError();
        id = raw.id as string | number;
        const key = JSON.stringify(id);
        // Lifetime bound prevents id replay and unbounded renderer traffic.
        if (this.seen.has(key) || this.seen.size >= 256 || this.active >= 4) { this.close(); throw appError(); }
        this.seen.add(key); this.active++; counted = true;
      }
      this.signal.throwIfAborted(); await this.operations.guard(); this.signal.throwIfAborted();
      if (raw.method === "ui/notifications/initialized" && id === undefined && this.initialized && !this.ready) { this.ready = true; return; }
      if (id === undefined) return; // No log/context/navigation/notification forwarding.
      let result: unknown;
      const params = object(raw.params) ? raw.params : {};
      if (raw.method === "ui/initialize" && !this.initialized) {
        if (params.protocolVersion !== "2026-01-26" || !object(params.appCapabilities) || !object(params.appInfo)) throw appError();
        this.initialized = true;
        result = { protocolVersion: "2026-01-26", hostInfo: { name: "May", version: "0.1.0" },
          hostCapabilities: { serverTools: {}, serverResources: {} },
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], toolInfo: { tool: this.tool } } };
      } else {
        if (!this.ready) throw appError();
        if (raw.method === "ping") result = {};
        else if (raw.method === "tools/call" && typeof params.name === "string" && (params.arguments === undefined || object(params.arguments))) {
          result = await this.operations.call(params.name, structuredClone(params.arguments ?? {}) as Record<string, unknown>, this.signal);
        } else if (raw.method === "resources/read" && typeof params.uri === "string") result = await this.operations.read(params.uri, this.signal);
        else return { jsonrpc: "2.0", id, error: { code: -32601, message: "This App capability is not supported by this host" } };
      }
      await this.operations.guard(); this.signal.throwIfAborted(); assertMcpContentSize(result);
      return { jsonrpc: "2.0", id, result };
    } catch {
      return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32000, message: "App request denied, expired, changed or failed; not replayed" } };
    } finally { if (counted) this.active--; }
  }
  /** Explicit host-selected tool data only. No Session history or automatic Context mutation. */
  async notification(kind: "tool-input" | "tool-result" | "tool-cancelled", params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.operations.guard(); this.signal.throwIfAborted();
    if (!this.ready || !["tool-input", "tool-result", "tool-cancelled"].includes(kind)) throw appError();
    assertMcpContentSize(params);
    return { jsonrpc: "2.0", method: `ui/notifications/${kind}`, params: structuredClone(params) };
  }
}
export function appError(): McpCapabilityError { return new McpCapabilityError("apps", "MCP App unavailable, unauthorized or invalid", "MCP_APP_ERROR"); }
