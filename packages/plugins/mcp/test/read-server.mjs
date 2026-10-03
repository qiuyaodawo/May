import { createMayMcpServer } from "../../../mcp/dist/server.js";
import { createReadTool } from "../../../tools/coding-tools/dist/index.js";
import { directToolExecutor } from "@may/core";

const workspace = process.argv[2];
const server = createMayMcpServer({
  endpoint: "http://127.0.0.1/mcp", workspaceId: workspace,
  authenticate: async () => undefined,
  authorize: async context => context.principal.workspaceId === workspace,
  executor: directToolExecutor,
  tools: [{ tool: createReadTool({ cwd: workspace }), result: output => ({ content: [{ type: "text", text: output.content }] }) }],
});
server.serveStdio({ id: "filesystem-owner", workspaceId: workspace });
