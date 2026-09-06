import { createMayMcpServer } from "../../dist/server.js";
import { directToolExecutor } from "@may/core";

const server = createMayMcpServer({ endpoint: "http://127.0.0.1/mcp", workspaceId: "stdio-workspace",
  ...(process.argv.includes("--legacy") ? { legacy: "stateless" } : {}),
  authenticate: async () => undefined, authorize: async () => true, executor: directToolExecutor,
  tools: [{ tool: { name: "who", description: "Inspect trusted export scope", inputSchema: { type: "object" },
    async execute(_input, context) { return context.scope; } }, result: (output) => ({ content: [{ type: "text", text: JSON.stringify(output) }] }) }],
});
server.serveStdio({ id: "local-launcher", workspaceId: "stdio-workspace" });
