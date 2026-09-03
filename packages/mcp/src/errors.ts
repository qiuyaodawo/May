import { MayError } from "@may/core";

export class McpConfigurationError extends MayError {
  constructor(message: string, options?: ErrorOptions) {
    super("MCP_CONFIGURATION_ERROR", message, options);
  }
}

export class McpConnectionError extends MayError {
  readonly serverId: string;
  readonly summary: string;
  readonly stderr: string | undefined;

  constructor(
    serverId: string,
    message: string,
    options?: ErrorOptions & { readonly stderr?: string },
  ) {
    super(
      "MCP_CONNECTION_FAILED",
      formatDiagnosticMessage(`MCP server "${serverId}": ${message}`, options?.stderr),
      options,
    );
    this.serverId = serverId;
    this.summary = message;
    this.stderr = options?.stderr;
  }
}

export class McpToolsListError extends MayError {
  readonly serverId: string;
  readonly summary: string;
  readonly stderr: string | undefined;

  constructor(
    serverId: string,
    message: string,
    options?: ErrorOptions & { readonly stderr?: string },
  ) {
    super(
      "MCP_TOOLS_LIST_FAILED",
      formatDiagnosticMessage(`MCP server "${serverId}": ${message}`, options?.stderr),
      options,
    );
    this.serverId = serverId;
    this.summary = message;
    this.stderr = options?.stderr;
  }
}

export class McpToolCallError extends MayError {
  readonly serverId: string;
  readonly remoteToolName: string;

  constructor(
    serverId: string,
    remoteToolName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      "MCP_TOOL_CALL_FAILED",
      `MCP tool "${serverId}/${remoteToolName}" failed: ${message}`,
      options,
    );
    this.serverId = serverId;
    this.remoteToolName = remoteToolName;
  }
}

export class McpToolReportedError extends MayError {
  readonly serverId: string;
  readonly remoteToolName: string;

  constructor(serverId: string, remoteToolName: string, detail: string) {
    super(
      "MCP_TOOL_ERROR",
      `MCP tool "${serverId}/${remoteToolName}" reported an error: ${detail}`,
    );
    this.serverId = serverId;
    this.remoteToolName = remoteToolName;
  }
}

export class McpClientPoolClosedError extends MayError {
  constructor() {
    super("MCP_CLIENT_POOL_CLOSED", "MCP client pool is closed");
  }
}

function formatDiagnosticMessage(message: string, stderr?: string): string {
  return stderr === undefined || stderr === ""
    ? message
    : `${message}\nRecent stderr:\n${stderr}`;
}
