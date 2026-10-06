import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function startLocalTelemetryService(t) {
  const state = { catalogs: 0, requests: [], efforts: ["low", "high"] };
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url.startsWith("/v1/models?")) {
      state.catalogs += 1;
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ models: [{ slug: "local-telemetry", supported_reasoning_levels: state.efforts, default_reasoning_level: state.efforts[0] }] }));
      return;
    }
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    state.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "internal diagnostic service reasoning" }, finish_reason: null }] })}\n\n`);
    await delay(5);
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `answer-${state.requests.length}` }, finish_reason: null }] })}\n\n`);
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`);
    outgoing.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { state, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

export function localTelemetrySelection(baseURL) {
  return {
    profile: "local", provider: "local", adapter: "openai-chat-completions", model: "local-telemetry",
    providerConfig: { adapter: "openai-chat-completions", apiKey: "local-service-credential", baseURL },
    options: {}, capabilities: { fields: { "input.text": true, "output.text": true } },
  };
}
