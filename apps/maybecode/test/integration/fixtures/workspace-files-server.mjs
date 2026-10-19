import { directToolExecutor } from "@sortedyuan/core";
import { createMayMcpServer } from "@sortedyuan/mcp/server";
import { createReadTool } from "@sortedyuan/coding-tools";

const workspace = process.cwd();
const server = createMayMcpServer({
  endpoint: "http://127.0.0.1/mcp", workspaceId: workspace,
  authenticate: async () => undefined,
  authorize: async context => context.principal.workspaceId === workspace,
  executor: directToolExecutor,
  tools: [{ tool: createReadTool({ cwd: workspace }), result: output => ({ content: [{ type: "text", text: output.content }] }) }],
});
server.serveStdio({ id: "workspace-files", workspaceId: workspace });
