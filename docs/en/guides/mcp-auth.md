# Configure MCP OAuth authentication

**English** | [简体中文](../../zh-CN/guides/mcp-auth.md)

Use this guide to authenticate a Streamable HTTP endpoint from MaybeCode or a
custom native Host. You need the endpoint's OAuth registration requirements,
trusted authorization origins, browser access and a working OS keyring or secure
credential store. Configure the endpoint first using the [MCP guide](mcp.md).

OAuth establishes the remote account identity. The application separately checks
permission to execute each tool. Stdio servers receive credentials through their
configured environment.

## Configure a native OAuth client

1. Add `auth` to the HTTP endpoint in your May configuration.
2. Replace the example endpoint, scopes and authorization origin with the values
   accepted by your service.

```json
{
  "apps": {
    "maybecode": {
      "mcpServers": {
        "remote": {
          "transport": "streamable-http",
          "url": "https://mcp.example.com/mcp",
          "auth": {
            "type": "oauth",
            "account": "work",
            "scopes": ["read"],
            "authorizationOrigins": ["https://accounts.example.com"]
          }
        }
      }
    }
  }
}
```

Omit `account` for the `default` credential profile. This local label selects a
credential profile. Authentication establishes the remote subject. The endpoint URL, account,
client registration configuration, and exact issuer partition credentials.
Aliases with the same endpoint/account/registration settings share grants.

The MCP endpoint's origin is trusted for OAuth network requests by default.
List additional **exact origins** in `authorizationOrigins` for identity
providers hosted elsewhere. Discovery, authorization URLs, token and revocation
requests reject other origins, credentials/fragments in URLs, and redirects.
HTTPS is required except for loopback hosts. These explicit destinations may be
private networks; use host network policy when stronger isolation is needed.
MCP request headers are not forwarded into OAuth requests. A static
`Authorization` header cannot be combined with OAuth.

Registration options:

- `clientId` plus `expectedIssuer`: a pre-registered **public native** client;
  issuer comparison is exact. Secret-based machine clients require a different integration.
- `clientMetadataUrl`: a public HTTPS Client ID Metadata Document with a document
  path. Used when the server advertises CIMD support.
- Otherwise the SDK uses legacy Dynamic Client Registration if advertised.

Do not specify both client ID options. `callbackPort` optionally selects a
loopback port (0–65535); the default 0 allocates an unused port. A new DCR login
registers again if a stored registration does not allow the new redirect URL.
Pre-registered clients/CIMD documents must allow the chosen native redirect.

## Login, refresh, and logout

1. From the repository root, log in using the configuration file you edited.
   For an installed CLI, replace `pnpm maybecode` with `maybecode`.

```powershell
pnpm maybecode mcp login remote --config ./may.config.json
pnpm maybecode mcp status remote --config ./may.config.json
```

2. Open the printed authorization URL and approve the requested scopes. Successful
   login saves credentials in the configured secure store.
3. In an already running MaybeCode workspace, execute `/mcp reconnect remote`.
   Check `/mcp` for the connected state, then start a new Run.
4. To authorize an additional scope or remove local credentials, use:

```powershell
pnpm maybecode mcp login remote --scope write --config ./may.config.json
pnpm maybecode mcp logout remote --config ./may.config.json
```

Commands also accept `--workspace <path>`. Login prints an authorization URL;
open it in a browser. May listens only on `127.0.0.1`, validates a random,
one-use state, and verifies the issuer before exchanging the PKCE-bound code or
interpreting callback errors. Ctrl+C or the five-minute deadline closes the
listener. The code verifier and discovery state are both process-lifetime;
quitting cancels the flow and discards that state.

Runtime requests read stored credentials and refresh on expiry or HTTP 401.
Refreshes are serialized and rediscover the issuer; credentials from an old
issuer are never redeemed with a new one. The transport retries a 401-denied
request at most once after refresh. Other tool/network failures are not replayed.
HTTP 403 `insufficient_scope` records the union of granted and requested scopes,
returns `MCP_AUTHENTICATION_REQUIRED`, and requires an explicit login/consent.
There is no browser prompt inside a tool execution. `/mcp` shows `auth-required`
when applicable. After login, use `/mcp reconnect <server-id>` to discover fresh
capabilities and create new permission identity, including for endpoints whose
initial discovery failed. Start a new Run after reconnecting.

Login stamps an opaque authorization generation. New operations, resource cache
hits and MRTR continuations validate it. Another login or logout, including from
another process, invalidates the old connection; reconnect before starting a new
operation. Token refresh preserves the generation.

`status` reports whether tokens are stored, whether consent is pending, and an
expiry timestamp where known; it is not remote token validation. Logout attempts
RFC 7009 revocation where advertised and always removes local grants. If remote
revocation is unavailable/failed, it says so; revoke access at the provider when
needed. Logout is not deletion of remote user data.

## Storage and embedding

MaybeCode uses `~/.may/maybecode/mcp-credentials` (under `dataDirectory` for
programmatic embedding). Records use AES-256-GCM, random nonces, key-bound AAD,
atomic writes and restrictive creation permissions. A 32-byte master key lives
in the OS keyring via the optional `@napi-rs/keyring` dependency. Large refresh
tokens do not depend on the native keyring's per-entry size limit. A locked,
missing or unsupported keyring fails closed: **no plaintext fallback**.
The native Windows backend has a local smoke test; other platforms require a
working system keyring/Secret Service. Moving encrypted files alone does not
move their OS-bound master key.

Credential operations use exclusive lock files. If a process crashes, inspect
the PID in its `.lock` file and verify it has exited before removing that lock;
the library does not steal a live lock based on age. Unlock the OS keyring or
inject a secure store on headless systems.

Library integrations create `new McpOAuthManager(store)` and pass it as `oauth`
to `openMcpClientPool`, or as `mcp.oauth` to configured MaybeCode. The manager
exposes `login`, `status`, and `logout`. Implement `McpCredentialStore` for other
secure backends; `InMemoryMcpCredentialStore` is an explicit non-persistent
alternative, never the automatic desktop fallback. Login accepts an
`onAuthorizationUrl` callback, `signal`, and `timeoutMs`.

Credentials, callback codes/state, and OAuth response bodies are not added to
model messages, Session history or built-in traces. Login URLs are deliberately
shown only in the authentication UI. OAuth fetches are bounded to 30 seconds
and 1 MiB per response. Server/tool content remains untrusted.

## Troubleshooting

| Symptom | Check and action |
| --- | --- |
| OAuth origin is rejected | Add the provider's exact trusted origin to `authorizationOrigins` |
| Callback cannot complete | Check the registered redirect URL and selected loopback port; restart login before its five-minute deadline |
| Credential store is unavailable | Unlock or configure the OS keyring, or inject a secure `McpCredentialStore` |
| A vault lock remains after a crash | Verify the recorded PID has exited before deleting that specific lock file |
| `MCP_AUTHENTICATION_REQUIRED` | Complete the explicit scope login, reconnect and start a new Run |

Connection and ownership limits are maintained in the [MCP capability reference](../reference/mcp-capabilities.md).
