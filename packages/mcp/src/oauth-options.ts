/** @experimental */
export interface McpOAuthOptions {
  readonly type: "oauth";
  /** User-selected credential profile; independent from May Session permissions. */
  readonly account?: string;
  /** Public pre-registered native client. Requires expectedIssuer. */
  readonly clientId?: string;
  readonly expectedIssuer?: string;
  /** Public Client ID Metadata Document; preferred over legacy dynamic registration. */
  readonly clientMetadataUrl?: string;
  readonly scopes?: readonly string[];
  /** Explicitly trusted origins for discovery, authorization and token endpoints. */
  readonly authorizationOrigins?: readonly string[];
  /** 0 (default) asks the OS for an unused loopback callback port. */
  readonly callbackPort?: number;
}

/** @experimental */
export function validateMcpOAuthOptions(value: McpOAuthOptions): void {
  if (value === null || typeof value !== "object" || value.type !== "oauth") throw new Error("auth.type must be oauth");
  const allowed = [
    "type",
    "account",
    "clientId",
    "expectedIssuer",
    "clientMetadataUrl",
    "scopes",
    "authorizationOrigins",
    "callbackPort",
  ];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("Unsupported MCP OAuth option");
  for (const name of ["account", "clientId", "expectedIssuer", "clientMetadataUrl"] as const) {
    if (value[name] !== undefined && (typeof value[name] !== "string" || value[name]!.trim() === ""))
      throw new Error(`auth.${name} must be a non-empty string`);
  }
  if (value.clientId !== undefined && value.expectedIssuer === undefined)
    throw new Error("auth.clientId requires expectedIssuer");
  if (value.clientId !== undefined && value.clientMetadataUrl !== undefined)
    throw new Error("Choose clientId or clientMetadataUrl");
  for (const name of ["scopes", "authorizationOrigins"] as const) {
    const list = value[name];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item)))
      throw new Error(`auth.${name} must contain strings`);
  }
  if (value.scopes?.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)))
    throw new Error("Invalid OAuth scope");
  for (const origin of value.authorizationOrigins ?? []) {
    const parsed = new URL(origin);
    assertSecureOAuthUrl(parsed);
    if (parsed.origin !== origin) throw new Error("auth.authorizationOrigins must contain origins only");
  }
  if (value.expectedIssuer !== undefined) assertSecureOAuthUrl(new URL(value.expectedIssuer));
  if (value.clientMetadataUrl !== undefined) {
    const url = new URL(value.clientMetadataUrl);
    assertSecureOAuthUrl(url);
    if (url.protocol !== "https:" || url.pathname === "/")
      throw new Error("clientMetadataUrl requires HTTPS and a document path");
  }
  if (
    value.callbackPort !== undefined &&
    (!Number.isSafeInteger(value.callbackPort) || value.callbackPort < 0 || value.callbackPort > 65535)
  ) {
    throw new Error("auth.callbackPort must be between 0 and 65535");
  }
}

export function assertSecureOAuthUrl(url: URL): void {
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  ) {
    throw new Error("OAuth endpoints must use HTTPS (HTTP is loopback-only), without credentials or fragments");
  }
}
