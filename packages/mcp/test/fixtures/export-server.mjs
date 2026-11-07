import { createMayMcpServer } from "../../dist/server.js";
import assert from "node:assert/strict";
import { PermissionToolExecutor } from "@sortedyuan/may/permissions";

const parsedInput = process.argv.includes("--undefined") ? undefined : null;
const server = createMayMcpServer({
  endpoint: "http://127.0.0.1/mcp",
  workspaceId: "stdio-workspace",
  ...(process.argv.includes("--legacy") ? { legacy: "stateless" } : {}),
  authenticate: async () => undefined,
  authorize: async () => true,
  executor: new PermissionToolExecutor({
    policy: ({ input }) => {
      assert.equal(input, parsedInput);
      return "allow";
    },
  }),
  tools: [
    {
      tool: {
        name: "who",
        description: "Inspect trusted export scope",
        inputSchema: { type: "object" },
        async parse() {
          return parsedInput;
        },
        async execute(_input, context) {
          assert.equal(_input, parsedInput);
          return context.scope;
        },
      },
      result: (output) => ({ content: [{ type: "text", text: JSON.stringify(output) }] }),
    },
  ],
});
server.serveStdio({ id: "local-launcher", workspaceId: "stdio-workspace" });
