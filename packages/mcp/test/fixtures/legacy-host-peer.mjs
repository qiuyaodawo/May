import { createInterface } from "node:readline";

/** Minimal legacy peer shared by real stdio and HTTP tests, no SDK internals. */
export function createLegacyHostPeer(send) {
  let seq = 0;
  const waiting = new Map();
  const ask = (method, params) => new Promise((resolve) => {
    const id = `host-${++seq}`;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  });
  const form = (label) => ask("elicitation/create", { mode: "form", message: `Form ${label}`, _meta: { sessionId: "forged" },
    requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } });
  const sample = (label) => ask("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: label } }], maxTokens: 32 });
  let bootstrap;
  return {
    ask,
    async handle(message) {
      if (message.method === undefined) {
        const resolve = waiting.get(message.id); waiting.delete(message.id);
        resolve?.(message.result ?? { error: message.error }); return;
      }
      const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "initialize": reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "legacy-host", version: "1" } }); break;
        case "notifications/initialized":
          bootstrap = Promise.all([ask("roots/list"), sample("unsolicited startup")]); break;
        case "tools/list": reply({ tools: [{ name: "interact", description: "Interact", inputSchema: { type: "object" } }] }); break;
        case "resources/list": reply({ resources: [{ uri: "test:///value", name: "value" }] }); break;
        case "resources/templates/list": reply({ resourceTemplates: [] }); break;
        case "prompts/list": reply({ prompts: [{ name: "review", arguments: [] }] }); break;
        case "resources/read": {
          const answer = await form("resource"); reply({ contents: [{ uri: message.params.uri, text: JSON.stringify(answer) }] }); break;
        }
        case "prompts/get": {
          const answer = await form("prompt"); reply({ messages: [{ role: "user", content: { type: "text", text: JSON.stringify(answer) } }] }); break;
        }
        case "tools/call": {
          const startup = await bootstrap;
          const label = message.params.arguments?.label ?? "call";
          const mode = message.params.arguments?.mode ?? "chain";
          if (mode === "early") { void form("early"); reply({ content: [{ type: "text", text: "early" }] }); break; }
          const roots = mode === "chain" ? await ask("roots/list") : undefined;
          const input = await form(label);
          const url = mode === "chain" ? await ask("elicitation/create", { mode: "url", message: "External consent", url: "https://example.com/consent", elicitationId: `url-${seq}` }) : undefined;
          const generated = mode === "chain" ? await sample(label) : undefined;
          reply({ content: [{ type: "text", text: JSON.stringify({ pid: process.pid, startup, roots, input, url, generated }) }] }); break;
        }
        case "ping": reply({}); break;
        default:
          if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    },
    close() { for (const resolve of waiting.values()) resolve({ error: "closed" }); waiting.clear(); },
  };
}

if (process.argv[2] === "--stdio") {
  const peer = createLegacyHostPeer((message) => process.stdout.write(JSON.stringify(message) + "\n"));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    void peer.handle(JSON.parse(line)).catch(() => process.exitCode = 1);
  }
  peer.close();
}
