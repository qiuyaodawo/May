import { resolve, join } from "node:path";
import { loadMayConfig, type MayConfig } from "@may/config";
import { KeyringMcpCredentialStore, McpOAuthManager } from "@may/mcp";
import type { MaybeCodeMcpCommand } from "./args.js";
import { getDefaultMaybeCodeDataDirectory, resolveMaybeCodeMcp } from "./configured.js";
import { MaybeCodeConfigError } from "./errors.js";

export interface MaybeCodeMcpAuthDependencies {
  readonly write: (text: string) => void;
  readonly oauth?: McpOAuthManager;
  readonly loadConfig?: (path?: string) => Promise<MayConfig>;
  readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

/** Authentication is available before agent/model startup, even for required endpoints. */
export async function runMaybeCodeMcpCommand(command: MaybeCodeMcpCommand, dependencies: MaybeCodeMcpAuthDependencies): Promise<void> {
  const config = await (dependencies.loadConfig?.(command.configPath) ??
    loadMayConfig(command.configPath === undefined ? {} : { path: command.configPath }));
  const mcp = resolveMaybeCodeMcp(config, resolve(command.workspace ?? process.cwd()));
  const server = mcp === false ? undefined : mcp.servers.find((entry) => entry.id === command.serverId);
  if (server?.transport !== "streamable-http" || server.auth === undefined) {
    throw new MaybeCodeConfigError(`MCP server "${command.serverId}" is missing, disabled, or not configured for OAuth`);
  }
  const oauth = dependencies.oauth ?? new McpOAuthManager(new KeyringMcpCredentialStore(
    join(getDefaultMaybeCodeDataDirectory(), "mcp-credentials"),
  ));
  switch (command.action) {
    case "login":
      await oauth.login({
        ...server,
        auth: { ...server.auth, scopes: [...server.auth.scopes ?? [], ...command.scopes ?? []] },
      }, {
        onAuthorizationUrl: dependencies.onAuthorizationUrl ?? ((url) => {
          dependencies.write(`Open this URL in your browser to authorize MCP server ${server.id}:\n${url.href}\nWaiting for authorization (Ctrl+C to cancel)...\n`);
        }),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
      dependencies.write(`MCP server ${server.id}: login complete. Restart an already-running workspace to reconnect.\n`);
      return;
    case "logout": {
      const result = await oauth.logout(server, dependencies.signal);
      dependencies.write(`MCP server ${server.id}: local credentials removed${result.revoked ? "; revocation completed where applicable" : "; remote revocation unavailable or failed — revoke access at the provider if needed"}.\n`);
      return;
    }
    case "status":
      dependencies.write(`MCP server ${server.id}: ${JSON.stringify(await oauth.status(server))}\n`);
  }
}
