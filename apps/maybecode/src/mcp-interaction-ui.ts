import { sanitizeTerminalText } from "@may/tui";
import type { McpInteractionRequest } from "@may/mcp";
import type { MaybeCodeController } from "./controller.js";

/** Shared ephemeral UI flow: no history, default acceptance, navigation, or model calls. */
export async function presentMcpInteraction(
  request: McpInteractionRequest,
  app: MaybeCodeController,
  ask: (prompt: string, signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  if (app.respondMcpInteraction === undefined) return;
  const header = sanitizeTerminalText(`MCP server: ${request.serverId}\nSession: ${request.owner.sessionId}\n` +
    `Request: ${request.requestId}\n${request.params.message}\n`);
  const question = async (prompt: string) => {
    signal.throwIfAborted();
    const answer = await ask(sanitizeTerminalText(prompt), signal);
    signal.throwIfAborted();
    return answer;
  };
  let error = "";
  while (!signal.aborted) {
    if (request.params.mode === "url") {
      const url = new URL(request.params.url);
      const consent = await question(`${header}\nExternal host: ${url.host}\nURL: ${request.params.url}\n` +
        "This is an untrusted external website, not MCP client login. Nothing opens automatically.\n" +
        "Type accept to consent, decline to refuse, or cancel to dismiss: ");
      if (consent?.trim().toLowerCase() !== "accept") {
        app.respondMcpInteraction(request.id, { action: consent?.trim().toLowerCase() === "decline" ? "decline" : "cancel" }); return;
      }
      const resume = await question(`${header}\nOpen the displayed URL yourself if you wish.\n` +
        "After interacting with the website, type retry to resume the original request, or cancel: ");
      app.respondMcpInteraction(request.id, { action: resume?.trim().toLowerCase() === "retry" ? "accept" : "cancel" }); return;
    }
    const answer = await question(`${header}\nNever enter passwords, API keys, tokens or payment credentials.\n` +
      `Requested form (untrusted):\n${JSON.stringify(request.params.requestedSchema, null, 2)}\n${error}` +
      "Enter a JSON object, decline, or cancel: ");
    if (answer === undefined || ["decline", "cancel"].includes(answer.trim().toLowerCase())) {
      app.respondMcpInteraction(request.id, { action: answer?.trim().toLowerCase() === "decline" ? "decline" : "cancel" }); return;
    }
    let content: Record<string, string | number | boolean | string[]>;
    try {
      if (Buffer.byteLength(answer) > 64 * 1024) throw new Error();
      const parsed: unknown = JSON.parse(answer);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      content = parsed as typeof content;
    } catch { error = "Invalid JSON object or response too large.\n"; continue; }
    const review = await question(`${header}\nReview what will be sent ONLY to this server:\n${JSON.stringify(content, null, 2)}\n` +
      "Type send to submit, edit to replace, decline, or cancel: ");
    const action = review?.trim().toLowerCase();
    if (action === "edit") continue;
    if (action !== "send") {
      app.respondMcpInteraction(request.id, { action: action === "decline" ? "decline" : "cancel" }); return;
    }
    try { app.respondMcpInteraction(request.id, { action: "accept", content }); return; }
    catch { error = "The response does not satisfy the form; please correct it.\n"; }
  }
}
