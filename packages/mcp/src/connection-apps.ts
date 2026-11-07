import { randomUUID } from "node:crypto";
import type { Tool as ProtocolTool } from "@modelcontextprotocol/client";
import { freezeToolInput, type Tool, type ToolExecutionContext } from "@sortedyuan/may/core";
import { McpAppSession, appError, mcpToolVisibility, parseMcpAppResource } from "./apps.js";
import type { McpCapabilities } from "./capabilities.js";
import { waitForHost } from "./host-wait.js";
import type { McpInteractionOwner } from "./interactions.js";
import type { McpServerCatalog, McpToolOutput, OpenMcpClientPoolOptions } from "./types.js";

interface McpAppConnection {
  readonly host: NonNullable<OpenMcpClientPoolOptions["apps"]>;
  readonly catalog: McpServerCatalog;
  readonly tool: ProtocolTool;
  readonly uri: string;
  readonly owner: McpInteractionOwner;
  readonly signal: AbortSignal;
  readonly serverId: string;
  readonly capabilities: McpCapabilities;
  guard(): Promise<void>;
  createTool(definition: ProtocolTool): Tool;
  ownApp(app: McpAppSession): void;
}

export async function openConnectionApp(connection: McpAppConnection): Promise<McpAppSession> {
  const { host, catalog, tool, uri, owner: trustedOwner, signal, serverId, capabilities, guard } = connection;
  const approve = async (kind: "open" | "read", target: string, currentSignal: AbortSignal) => {
    await guard();
    currentSignal.throwIfAborted();
    if (
      (await waitForHost(currentSignal, () =>
        host.approve({ kind, serverId, uri: target, owner: trustedOwner, signal: currentSignal }),
      )) !== true
    )
      throw appError();
    await guard();
    currentSignal.throwIfAborted();
  };
  await approve("open", uri, signal);
  const resource = parseMcpAppResource(
    uri,
    (await capabilities.readResource(uri, { owner: trustedOwner, signal, cache: "bypass" })).result,
  );
  await guard();
  const app = new McpAppSession(
    resource,
    tool,
    {
      guard,
      call: async (name, input, currentSignal) => {
        await guard();
        const definition = catalog.tools.find((entry) => entry.name === name && mcpToolVisibility(entry, "app"));
        if (definition === undefined) throw appError();
        const adapted = connection.createTool(definition);
        const operationId = randomUUID();
        const context: ToolExecutionContext = {
          scope: { workspaceId: trustedOwner.workspaceId, sessionId: trustedOwner.sessionId },
          runId: trustedOwner.runId ?? `mcp-app:${operationId}`,
          step: 0,
          toolCallId: operationId,
          idempotencyKey: operationId,
          signal: currentSignal,
          report() {},
        };
        const parsedInput = adapted.parse ? await adapted.parse(input) : input;
        currentSignal.throwIfAborted();
        const result = await waitForHost(currentSignal, () =>
          host.executor.execute({ tool: adapted, input: freezeToolInput(parsedInput), context }),
        );
        await guard();
        return result as McpToolOutput;
      },
      read: async (target, currentSignal) => {
        if (target !== uri && !catalog.resources.some((entry) => entry.uri === target)) throw appError();
        await approve("read", target, currentSignal);
        const read = await capabilities.readResource(target, {
          owner: trustedOwner,
          signal: currentSignal,
          cache: "bypass",
        });
        await guard();
        return read.result;
      },
    },
    signal,
  );
  connection.ownApp(app);
  return app;
}
