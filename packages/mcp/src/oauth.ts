import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  auth, computeScopeUnion, extractWWWAuthenticateParams, validateAuthorizationResponseIssuer,
  type AuthProvider, type FetchLike, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { MayError } from "@may/core";
import type { McpCredentialStore } from "./credentials.js";
import type { McpHttpServerOptions } from "./types.js";

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

export class McpAuthenticationError extends MayError {
  constructor(readonly serverId: string, required = false) {
    super(required ? "MCP_AUTHENTICATION_REQUIRED" : "MCP_AUTHENTICATION_FAILED",
      required ? `MCP server "${serverId}" requires login or additional consent; run maybecode mcp login ${serverId}`
        : `MCP server "${serverId}" authentication failed (sensitive details withheld)`);
  }
}

interface Grant {
  tokens?: StoredOAuthTokens;
  client?: StoredOAuthClientInformation;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}
interface Credentials {
  version: 1;
  authorizationId?: string;
  issuer?: string;
  redirectUrl?: string;
  pendingScope?: string;
  grants: Record<string, Grant>;
}

export interface McpLoginOptions {
  /** Host displays or opens this URL; it must never enter model/session/tracing data. */
  readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Owns credentials and OAuth flows, not UI, model access, or tool authorization. */
export class McpOAuthManager {
  constructor(readonly store: McpCredentialStore) {}

  async status(server: McpHttpServerOptions) {
    const state = await this.read(server);
    const grant = state.issuer === undefined ? undefined : state.grants[state.issuer];
    return {
      authenticated: grant?.tokens !== undefined,
      requiresConsent: state.pendingScope !== undefined,
      ...(grant?.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
    };
  }

  /** Opaque grant generation; validates stored credentials before serving private caches. */
  async authorizationIdentity(server: McpHttpServerOptions): Promise<string> {
    const token = await this.binding(server).token();
    if (token === undefined) throw new McpAuthenticationError(server.id, true);
    const state = await this.read(server);
    const grant = state.issuer === undefined ? undefined : state.grants[state.issuer];
    return createHash("sha256").update(JSON.stringify([
      state.authorizationId ?? grant?.tokens, state.issuer, grant?.tokens?.scope,
    ])).digest("hex");
  }

  /** Noninteractive binding: refresh on expiry/401, never open a browser in a tool call. */
  binding(server: McpHttpServerOptions): AuthProvider {
    return {
      token: async () => {
        let state = await this.read(server);
        if (state.pendingScope !== undefined) throw new McpAuthenticationError(server.id, true);
        let grant = state.issuer === undefined ? undefined : state.grants[state.issuer];
        if (grant?.expiresAt !== undefined && grant.expiresAt <= Date.now() + 10_000) {
          await this.authorize(server);
          state = await this.read(server);
          grant = state.issuer === undefined ? undefined : state.grants[state.issuer];
        }
        return grant?.tokens?.access_token;
      },
      onUnauthorized: async ({ response }) => {
        const challenge = extractWWWAuthenticateParams(response);
        await this.authorize(server, challenge.resourceMetadataUrl, challenge.scope);
      },
    };
  }

  /** Persist a 403 scope challenge for the next explicit login without replaying the tool. */
  async requireConsent(server: McpHttpServerOptions, response: Response): Promise<void> {
    const challenge = extractWWWAuthenticateParams(response);
    if (challenge.error !== "insufficient_scope") return;
    await this.store.exclusive(this.key(server), async () => {
      const state = await this.read(server);
      const granted = state.issuer === undefined ? undefined : state.grants[state.issuer]?.tokens?.scope;
      state.pendingScope = computeScopeUnion(granted, state.pendingScope, challenge.scope) ?? "";
      await this.store.set(this.key(server), state);
    });
    throw new McpAuthenticationError(server.id, true);
  }

  async login(server: McpHttpServerOptions, options: McpLoginOptions): Promise<void> {
    const settings = oauthSettings(server);
    validateMcpOAuthOptions(settings);
    const duration = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(duration) || duration < 1) throw new McpAuthenticationError(server.id);
    const signal = AbortSignal.any([
      ...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(duration),
    ]);
    await this.store.exclusive(this.key(server), async () => {
      const csrf = randomBytes(32).toString("base64url");
      const callback = await listenForCallback(csrf, settings.callbackPort ?? 0, signal);
      try {
        const state = await this.read(server);
        state.redirectUrl = callback.url;
        state.authorizationId = randomBytes(32).toString("hex");
        const provider = this.provider(server, state, callback.url, csrf, options.onAuthorizationUrl);
        const fetchFn = this.authFetch(server, signal);
        const scope = computeScopeUnion(settings.scopes?.join(" "), state.pendingScope,
          state.issuer === undefined ? undefined : state.grants[state.issuer]?.tokens?.scope);
        const result = await auth(provider, {
          serverUrl: server.url, fetchFn, forceReauthorization: true,
          ...(scope === undefined ? {} : { scope }),
        });
        if (result === "REDIRECT") {
          const parameters = await callback.result;
          const discovery = await provider.discoveryState!();
          validateAuthorizationResponseIssuer({
            iss: parameters.get("iss") ?? undefined,
            expectedIssuer: discovery?.authorizationServerMetadata?.issuer,
            issParameterSupported: discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true,
          });
          // Only inspect callback error fields after issuer validation. Never display their values.
          if (parameters.has("error") || !parameters.get("code")) throw new McpAuthenticationError(server.id);
          await auth(provider, {
            serverUrl: server.url, fetchFn, authorizationCode: parameters.get("code")!,
            ...(parameters.has("iss") ? { iss: parameters.get("iss")! } : {}),
            ...(scope === undefined ? {} : { scope }),
          });
        }
        delete state.pendingScope;
        await this.store.set(this.key(server), state);
      } finally { await callback.close(); }
    }, signal).catch((error: unknown) => this.fail(server, error, signal));
  }

  /** Always erases local grants; attempts RFC 7009 revocation where advertised. */
  async logout(server: McpHttpServerOptions, signal?: AbortSignal): Promise<{ revoked: boolean }> {
    return this.store.exclusive(this.key(server), async () => {
      const state = await this.read(server);
      let revoked = true;
      try {
        for (const grant of Object.values(state.grants)) {
          if (grant.tokens === undefined) continue;
          const metadata = grant.discovery?.authorizationServerMetadata;
          const endpoint = metadata !== undefined && "revocation_endpoint" in metadata &&
            typeof metadata.revocation_endpoint === "string" ? metadata.revocation_endpoint : undefined;
          if (endpoint === undefined || grant.client === undefined) { revoked = false; continue; }
          try {
            const response = await this.authFetch(server, signal)(endpoint, {
              method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: grant.tokens.refresh_token ?? grant.tokens.access_token,
                token_type_hint: grant.tokens.refresh_token ? "refresh_token" : "access_token",
                client_id: grant.client.client_id,
              }),
            });
            revoked &&= response.ok;
          } catch { revoked = false; }
        }
      } finally { await this.store.delete(this.key(server)); }
      return { revoked };
    }, signal);
  }

  private async authorize(server: McpHttpServerOptions, resourceMetadataUrl?: URL, requestedScope?: string) {
    return this.store.exclusive(this.key(server), async () => {
      const state = await this.read(server);
      if (state.pendingScope !== undefined) throw new McpAuthenticationError(server.id, true);
      const provider = this.provider(server, state, state.redirectUrl ?? "http://127.0.0.1:1/oauth/callback");
      const scope = computeScopeUnion(oauthSettings(server).scopes?.join(" "), requestedScope,
        state.issuer === undefined ? undefined : state.grants[state.issuer]?.tokens?.scope);
      // Discover again on expiry/401, so a moved issuer cannot consume old refresh/client credentials.
      await auth(provider, {
        serverUrl: server.url, fetchFn: this.authFetch(server),
        ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
        ...(scope === undefined ? {} : { scope }),
      });
    }).catch((error: unknown) => this.fail(server, error));
  }

  private provider(server: McpHttpServerOptions, state: Credentials, redirectUrl: string,
    csrf?: string, onUrl?: (url: URL) => void | Promise<void>): OAuthClientProvider {
    const settings = oauthSettings(server);
    let discovery: OAuthDiscoveryState | undefined;
    let verifier: string | undefined;
    const persist = () => this.store.set(this.key(server), state);
    const currentIssuer = (candidate?: string) => candidate ?? discovery?.authorizationServerMetadata?.issuer
      ?? discovery?.authorizationServerUrl ?? state.issuer;
    const grant = (issuer: string): Grant => state.grants[issuer] ??= {};
    const provider: OAuthClientProvider = {
      redirectUrl,
      ...(settings.clientMetadataUrl === undefined ? {} : { clientMetadataUrl: settings.clientMetadataUrl }),
      clientMetadata: {
        client_name: "May MCP", application_type: "native", redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => { if (csrf === undefined) throw new McpAuthenticationError(server.id, true); return csrf; },
      clientInformation: (ctx) => {
        const issuer = currentIssuer(ctx?.issuer);
        if (issuer === undefined) return undefined;
        if (settings.expectedIssuer !== undefined && settings.expectedIssuer !== issuer) throw new McpAuthenticationError(server.id);
        if (settings.clientId !== undefined) return { client_id: settings.clientId, issuer };
        const saved = grant(issuer).client;
        // A new random callback port needs matching DCR registration, not an old redirect binding.
        if (onUrl !== undefined && saved !== undefined && "redirect_uris" in saved &&
            !saved.redirect_uris.includes(redirectUrl)) return undefined;
        return saved?.issuer === issuer ? saved : undefined;
      },
      saveClientInformation: async (client, ctx) => {
        const issuer = currentIssuer(ctx?.issuer ?? client.issuer);
        if (issuer === undefined || client.issuer !== issuer) throw new McpAuthenticationError(server.id);
        grant(issuer).client = client;
        await persist();
      },
      tokens: (ctx) => {
        const issuer = currentIssuer(ctx?.issuer);
        if (issuer === undefined) return undefined;
        const tokens = grant(issuer).tokens;
        return tokens?.issuer === issuer ? tokens : undefined;
      },
      saveTokens: async (tokens, ctx) => {
        const issuer = currentIssuer(ctx?.issuer ?? tokens.issuer);
        if (issuer === undefined || tokens.issuer !== issuer) throw new McpAuthenticationError(server.id);
        state.issuer = issuer;
        if (settings.clientId !== undefined) grant(issuer).client = { client_id: settings.clientId, issuer };
        const previous = grant(issuer).tokens;
        grant(issuer).tokens = {
          ...tokens,
          ...(onUrl === undefined && tokens.refresh_token === undefined && previous?.refresh_token !== undefined
            ? { refresh_token: previous.refresh_token } : {}),
        };
        if (tokens.expires_in !== undefined) grant(issuer).expiresAt = Date.now() + tokens.expires_in * 1_000;
        else delete grant(issuer).expiresAt;
        if (discovery !== undefined) grant(issuer).discovery = discovery;
        await persist();
      },
      redirectToAuthorization: async (url) => {
        this.assertAuthUrl(server, url);
        if (onUrl === undefined) {
          state.pendingScope = url.searchParams.get("scope") ?? "";
          await persist();
          throw new McpAuthenticationError(server.id, true);
        }
        await onUrl(url);
      },
      saveCodeVerifier: (value) => { verifier = value; },
      codeVerifier: () => { if (verifier === undefined) throw new McpAuthenticationError(server.id); return verifier; },
      saveDiscoveryState: (value) => {
        this.assertAuthUrl(server, new URL(value.authorizationServerUrl));
        if (settings.expectedIssuer !== undefined && value.authorizationServerMetadata?.issuer !== settings.expectedIssuer) {
          throw new McpAuthenticationError(server.id);
        }
        discovery = value;
      },
      discoveryState: () => discovery,
      invalidateCredentials: async (scope) => {
        const issuer = currentIssuer();
        if (scope === "discovery") { discovery = undefined; return; }
        if (scope === "verifier") { verifier = undefined; return; }
        if (issuer !== undefined) {
          if (scope === "all") delete state.grants[issuer];
          else if (scope === "tokens") { delete grant(issuer).tokens; delete grant(issuer).expiresAt; }
          else if (scope === "client") delete grant(issuer).client;
        }
        await persist();
      },
    };
    return provider;
  }

  private async read(server: McpHttpServerOptions): Promise<Credentials> {
    return await this.store.get<Credentials>(this.key(server)) ?? { version: 1, grants: {} };
  }
  private key(server: McpHttpServerOptions): string {
    const settings = oauthSettings(server);
    return JSON.stringify(["oauth-v1", new URL(server.url).href, settings.account ?? "default",
      settings.clientId ?? settings.clientMetadataUrl ?? "dynamic", settings.expectedIssuer ?? null]);
  }
  private assertAuthUrl(server: McpHttpServerOptions, url: URL): void {
    assertSecureOAuthUrl(url);
    const origins = [new URL(server.url).origin, ...(oauthSettings(server).authorizationOrigins ?? [])];
    if (!origins.includes(url.origin)) throw new McpAuthenticationError(server.id);
  }
  private authFetch(server: McpHttpServerOptions, signal?: AbortSignal): FetchLike {
    return async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      this.assertAuthUrl(server, url);
      const combined = AbortSignal.any([
        ...(signal === undefined ? [] : [signal]), ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(30_000),
      ]);
      // Never inherit MCP headers/cookies into authorization-server requests.
      const response = await fetch(url, { ...init, signal: combined, redirect: "error", credentials: "omit" });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (reader !== undefined) while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 1024 * 1024) throw new McpAuthenticationError(server.id);
          chunks.push(part.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      return new Response(length === 0 ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers });
    };
  }
  private fail(server: McpHttpServerOptions, error: unknown, signal?: AbortSignal): never {
    signal?.throwIfAborted();
    if (error instanceof MayError) throw error;
    throw new McpAuthenticationError(server.id);
  }
}

function oauthSettings(server: McpHttpServerOptions): McpOAuthOptions {
  if (server.auth?.type !== "oauth") throw new McpAuthenticationError(server.id);
  return server.auth;
}

export function validateMcpOAuthOptions(value: McpOAuthOptions): void {
  if (value === null || typeof value !== "object" || value.type !== "oauth") throw new Error("auth.type must be oauth");
  const allowed = ["type", "account", "clientId", "expectedIssuer", "clientMetadataUrl", "scopes", "authorizationOrigins", "callbackPort"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("Unsupported MCP OAuth option");
  for (const name of ["account", "clientId", "expectedIssuer", "clientMetadataUrl"] as const) {
    if (value[name] !== undefined && (typeof value[name] !== "string" || value[name]!.trim() === "")) throw new Error(`auth.${name} must be a non-empty string`);
  }
  if (value.clientId !== undefined && value.expectedIssuer === undefined) throw new Error("auth.clientId requires expectedIssuer");
  if (value.clientId !== undefined && value.clientMetadataUrl !== undefined) throw new Error("Choose clientId or clientMetadataUrl");
  for (const name of ["scopes", "authorizationOrigins"] as const) {
    const list = value[name];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item))) throw new Error(`auth.${name} must contain strings`);
  }
  if (value.scopes?.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope))) throw new Error("Invalid OAuth scope");
  for (const origin of value.authorizationOrigins ?? []) {
    const parsed = new URL(origin);
    assertSecureOAuthUrl(parsed);
    if (parsed.origin !== origin) throw new Error("auth.authorizationOrigins must contain origins only");
  }
  if (value.expectedIssuer !== undefined) assertSecureOAuthUrl(new URL(value.expectedIssuer));
  if (value.clientMetadataUrl !== undefined) {
    const url = new URL(value.clientMetadataUrl);
    assertSecureOAuthUrl(url);
    if (url.protocol !== "https:" || url.pathname === "/") throw new Error("clientMetadataUrl requires HTTPS and a document path");
  }
  if (value.callbackPort !== undefined && (!Number.isSafeInteger(value.callbackPort) || value.callbackPort < 0 || value.callbackPort > 65535)) {
    throw new Error("auth.callbackPort must be between 0 and 65535");
  }
}

function assertSecureOAuthUrl(url: URL): void {
  if (url.username || url.password || url.hash || !(url.protocol === "https:" ||
      url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("OAuth endpoints must use HTTPS (HTTP is loopback-only), without credentials or fragments");
  }
}

async function listenForCallback(state: string, port: number, signal: AbortSignal) {
  signal.throwIfAborted();
  let complete!: (params: URLSearchParams) => void;
  let fail!: (reason: unknown) => void;
  const result = new Promise<URLSearchParams>((resolve, reject) => { complete = resolve; fail = reject; });
  void result.catch(() => {});
  let url = "";
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    if (consumed || request.method !== "GET" || (request.url?.length ?? 0) > 8192) { response.writeHead(400).end(); return; }
    let target: URL;
    try { target = new URL(request.url ?? "/", url); }
    catch { response.writeHead(400).end(); return; }
    if (request.headers.host !== new URL(url).host || target.origin !== new URL(url).origin || target.pathname !== "/oauth/callback") {
      response.writeHead(404).end(); return;
    }
    const actual = Buffer.from(target.searchParams.get("state") ?? "");
    if (["state", "code", "iss", "error"].some((key) => target.searchParams.getAll(key).length > 1) ||
        actual.length !== Buffer.byteLength(state) || !timingSafeEqual(actual, Buffer.from(state))) {
      response.writeHead(400).end("Invalid authorization callback."); return;
    }
    consumed = true;
    response.end("Authorization callback received. Return to May to check the result.");
    complete(target.searchParams);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Callback listener unavailable");
  url = `http://127.0.0.1:${address.port}/oauth/callback`;
  const abort = () => { fail(signal.reason); void closeServer(server); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { url, result, close: async () => {
    signal.removeEventListener("abort", abort);
    await closeServer(server);
  } };
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
