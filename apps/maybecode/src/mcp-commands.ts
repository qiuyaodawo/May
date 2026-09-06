import { mcpPromptToUserMessage, mcpResourceToUserMessage, previewMcpMessage } from "@may/mcp";
import type { MaybeCodeController } from "./controller.js";
import type { MaybeCodeSlashCommandResult } from "./slash-commands.js";

export const MCP_COMMAND_USAGE = "/mcp [apps | catalog [server] | refresh [server] | reconnect server | read server uri | attach server uri [question] | template server uri-template {arguments} | prompt server name {arguments} | use-prompt server name {arguments} | complete server {params} | watch server uri | unwatch server uri | tasks [server] | task-get server id | task-wait server id | task-update server id | task-retry-input server id | task-cancel server id | task-forget server id | task-attach server id [question]]";

/** Keep JSON tail byte-for-byte, unlike the general whitespace-only command parser. */
export async function executeMcpCommand(input: string, controller: MaybeCodeController): Promise<MaybeCodeSlashCommandResult> {
  const match = /^\S+(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(input.trim())!;
  const [, action, serverId, tail] = match;
  const display = (text: string): MaybeCodeSlashCommandResult => ({ type: "mcp.display", text: text.slice(0, 16_000) });
  const usage = (): MaybeCodeSlashCommandResult => ({ type: "usage", usage: MCP_COMMAND_USAGE });
  if (action === "apps") return display("MCP Apps HTML is not supported in this terminal. Text tool results remain available; use an explicitly configured isolated graphical Host. No HTML was fetched or executed.");
  if (action === undefined) return { type: "mcp.status", servers: await controller.getMcpStatus() };
  if (action === "tasks" && tail === undefined && controller.listMcpTasks !== undefined) {
    const records = (await controller.listMcpTasks()).filter((record) => serverId === undefined || record.binding.serverId === serverId);
    return display(JSON.stringify(records.map(({ id, binding, status, cancellation }) => ({ id, server: binding.serverId, tool: binding.toolName, status, cancellation })), null, 2));
  }
  if (action === "catalog" && tail === undefined && controller.getMcpCatalog !== undefined) {
    const catalogs = controller.getMcpCatalog().filter((catalog) => serverId === undefined || catalog.serverId === serverId);
    return display(JSON.stringify(catalogs, null, 2));
  }
  if (action === "refresh" && tail === undefined && controller.refreshMcp !== undefined) await controller.refreshMcp(serverId);
  else if (action === "reconnect" && serverId !== undefined && tail === undefined && controller.reconnectMcp !== undefined) await controller.reconnectMcp(serverId);
  else {
    if (serverId === undefined || tail === undefined) return usage();
    if (action === "complete" && controller.completeMcp !== undefined) {
      return display(JSON.stringify(await controller.completeMcp(serverId, JSON.parse(tail)), null, 2));
    }
    const target = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(tail)!;
    const name = target[1]!;
    const rest = target[2];
    if (action === "task-attach" && controller.submitMcpTask !== undefined) return { type: "mcp.run-started", run: await controller.submitMcpTask(serverId, name, rest) };
    if (rest === undefined) {
      if (action === "task-get" && controller.getMcpTask !== undefined) return display(JSON.stringify((await controller.getMcpTask(serverId, name)).state, null, 2));
      if (action === "task-wait" && controller.waitMcpTask !== undefined) return display(JSON.stringify((await controller.waitMcpTask(serverId, name)).state, null, 2));
      if (action === "task-update" && controller.updateMcpTask !== undefined) return display(JSON.stringify((await controller.updateMcpTask(serverId, name)).state, null, 2));
      if (action === "task-retry-input" && controller.updateMcpTask !== undefined) return display(JSON.stringify((await controller.updateMcpTask(serverId, name, { retryAbandonedInputs: true })).state, null, 2));
      if (action === "task-cancel" && controller.cancelMcpTask !== undefined) {
        const record = await controller.cancelMcpTask(serverId, name);
        return display(`Cancellation ${record.cancellation}; last observed status: ${record.status}. Acknowledgement does not prove the remote work stopped.`);
      }
      if (action === "task-forget" && controller.forgetMcpTask !== undefined) {
        await controller.forgetMcpTask(serverId, name); return display("Forgot the local task handle only. Remote work was not cancelled or deleted.");
      }
    }
    if (action === "read" && rest === undefined && controller.readMcpResource !== undefined) {
      return display(previewMcpMessage(mcpResourceToUserMessage(await controller.readMcpResource(serverId, name))));
    }
    if (action === "template" && rest !== undefined && controller.readMcpResourceTemplate !== undefined) {
      return display(previewMcpMessage(mcpResourceToUserMessage(await controller.readMcpResourceTemplate(serverId, name, JSON.parse(rest)))));
    }
    if (action === "attach" && controller.submitMcpResource !== undefined) {
      return { type: "mcp.run-started", run: await controller.submitMcpResource(serverId, name, rest) };
    }
    if (action === "prompt" && controller.getMcpPrompt !== undefined) {
      return display(previewMcpMessage(mcpPromptToUserMessage(await controller.getMcpPrompt(serverId, name, rest === undefined ? {} : JSON.parse(rest)))));
    }
    if (action === "use-prompt" && controller.submitMcpPrompt !== undefined) {
      return { type: "mcp.run-started", run: await controller.submitMcpPrompt(serverId, name, rest === undefined ? {} : JSON.parse(rest)) };
    }
    if (action === "watch" && rest === undefined && controller.watchMcpResource !== undefined) {
      await controller.watchMcpResource(serverId, name);
      return display(`Watching ${serverId}: ${name} (notifications only; no automatic context updates)`);
    }
    if (action === "unwatch" && rest === undefined && controller.unwatchMcpResource !== undefined) {
      await controller.unwatchMcpResource(serverId, name);
      return display(`Stopped watching ${serverId}: ${name}`);
    }
    return usage();
  }
  return { type: "mcp.status", servers: await controller.getMcpStatus() };
}
