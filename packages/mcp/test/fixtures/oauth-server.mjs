import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";

export async function startOAuthFixture(t) {
  let origin;
  let issuer;
  let access;
  let refresh;
  let scope = "read";
  let demandWrite = false;
  const codes = new Map();
  const clients = new Map();
  const requests = [];
  const counts = { exchanges: 0, refreshes: 0, revocations: 0, toolCalls: 0, registrations: 0 };
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url, origin);
      requests.push({ url, headers: req.headers, method: req.method });
      const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: ["read", "write"] });
      } else if (url.pathname.startsWith("/.well-known/")) {
        json({
          issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: true,
        });
      } else if (url.pathname === "/register") {
        counts.registrations++;
        const metadata = JSON.parse(body);
        assert.equal(metadata.application_type, "native");
        assert.ok(metadata.grant_types.includes("refresh_token"));
        const client = { ...metadata, client_id: randomUUID() };
        clients.set(client.client_id, client);
        json(client, 201);
      } else if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("resource"), `${origin}/mcp`);
        const client = clients.get(url.searchParams.get("client_id"));
        const knownPublic = ["may-public", "https://client.example/metadata.json"].includes(url.searchParams.get("client_id"));
        assert.ok(knownPublic || client?.redirect_uris.includes(url.searchParams.get("redirect_uri")));
        const code = randomUUID();
        codes.set(code, url.searchParams);
        const callback = new URL(url.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("iss", issuer);
        res.writeHead(302, { location: callback.href }).end();
      } else if (url.pathname === "/token") {
        const params = new URLSearchParams(body);
        assert.equal(params.get("resource"), `${origin}/mcp`);
        if (params.get("grant_type") === "authorization_code") {
          counts.exchanges++;
          const saved = codes.get(params.get("code"));
          assert.ok(saved);
          assert.equal(params.get("client_id"), saved.get("client_id"));
          assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), saved.get("code_challenge"));
          codes.delete(params.get("code"));
          scope = saved.get("scope") ?? "read";
        } else {
          counts.refreshes++;
          assert.equal(params.get("grant_type"), "refresh_token");
          assert.equal(params.get("refresh_token"), refresh);
        }
        access = `access-${randomUUID()}`;
        refresh = `refresh-${randomUUID()}`;
        json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope });
      } else if (url.pathname === "/revoke") {
        counts.revocations++;
        const token = new URLSearchParams(body).get("token");
        if (token === refresh) { access = undefined; refresh = undefined; }
        res.writeHead(200).end();
      } else if (url.pathname === "/mcp") {
        if (req.headers.authorization !== `Bearer ${access}` || access === undefined) {
          res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="read"` }).end("do-not-log-response");
          return;
        }
        const message = JSON.parse(body);
        const reply = (result) => json({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...result } });
        if (message.method === "server/discover") reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } });
        else if (message.method === "tools/list") reply({ ttlMs: 0, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object" } }] });
        else if (message.method === "resources/list") reply({ resources: [{ name: "private", uri: "private:///data" }], ttlMs: 0, cacheScope: "private" });
        else if (message.method === "resources/templates/list") reply({ resourceTemplates: [], ttlMs: 0, cacheScope: "private" });
        else if (message.method === "resources/read") reply({ contents: [{ uri: message.params.uri, text: "private-account-data" }], ttlMs: 300000, cacheScope: "private" });
        else if (message.method === "tools/call") {
          counts.toolCalls++;
          if (demandWrite && !scope.split(" ").includes("write")) {
            res.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' }).end();
          } else reply({ content: [{ type: "text", text: "authorized" }] });
        } else res.writeHead(202).end();
      } else res.writeHead(404).end();
    } catch (error) { failures.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  issuer = origin;
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.deepEqual(failures, []);
  });
  return {
    url: `${origin}/mcp`, origin, counts, requests,
    invalidateAccess: () => { access = "expired"; },
    demandWrite: () => { demandWrite = true; },
    rotateIssuer: () => { issuer = `${origin}/issuer2`; access = "expired"; },
    async callback(url) {
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 302);
      return new URL(response.headers.get("location"));
    },
  };
}
