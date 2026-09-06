/** Browser-only entry point: no Node imports, credentials, executor or Session state. */
export interface McpAppChannel {
  readonly resource: { readonly html: string };
  /** Authenticated backend channel bound to exactly one McpAppSession. */
  receive(message: unknown): Promise<Record<string, unknown> | undefined>;
  close(): void;
  readonly signal?: AbortSignal;
}

/** Mount only on an explicit user action. The sandbox URL is host configuration, not server metadata. */
export function mountMcpApp(container: HTMLElement, sandboxUrl: string, channel: McpAppChannel) {
  const document = container.ownerDocument;
  const host = document.defaultView!;
  const url = new URL(sandboxUrl);
  if (url.origin === host.location.origin || url.username || url.password || url.hash ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("MCP Apps require a separately controlled sandbox origin");
  if (new TextEncoder().encode(channel.resource.html).length > 2 * 1024 * 1024) throw new Error("MCP App exceeds HTML limit");
  const frame = document.createElement("iframe");
  frame.title = "Untrusted MCP App";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText = "width:100%;height:480px;border:1px solid currentColor";
  let closed = false; let supplied = false; let active = 0;
  const post = (message: Record<string, unknown>) => {
    if (!closed) frame.contentWindow?.postMessage(message, url.origin);
  };
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); host.removeEventListener("message", receive);
    channel.signal?.removeEventListener("abort", close); frame.remove(); channel.close();
  };
  const receive = (event: MessageEvent) => {
    if (closed || event.source !== frame.contentWindow || event.origin !== url.origin) return;
    let bytes: number;
    try { bytes = new TextEncoder().encode(JSON.stringify(event.data)).length; } catch { close(); return; }
    if (bytes > 256 * 1024 || event.data?.jsonrpc !== "2.0") { close(); return; }
    if (event.data.method === "ui/notifications/sandbox-proxy-ready") {
      if (supplied) { close(); return; }
      supplied = true;
      post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: channel.resource.html } });
      return;
    }
    if (!supplied || typeof event.data.method !== "string" || event.data.method.startsWith("ui/notifications/sandbox-")) return;
    if (active >= 4) { close(); return; }
    active++;
    void channel.receive(event.data).then((response) => { if (response !== undefined) post(response); }, close).finally(() => { active--; });
  };
  const timer = setTimeout(close, 600_000);
  host.addEventListener("message", receive);
  channel.signal?.addEventListener("abort", close, { once: true });
  if (channel.signal?.aborted) close();
  else { frame.src = url.href; container.append(frame); }
  return { close,
    /** Pass only a backend-validated McpAppSession.notification result. */
    send(message: Record<string, unknown>) {
      if (!supplied || !["ui/notifications/tool-input", "ui/notifications/tool-result", "ui/notifications/tool-cancelled"].includes(message.method as string)) throw new Error("Unsupported App notification");
      if (new TextEncoder().encode(JSON.stringify(message)).length > 8 * 1024 * 1024) throw new Error("App notification exceeds limit");
      post(message);
    },
  };
}
