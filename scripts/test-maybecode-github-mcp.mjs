// Opt-in live smoke: no provider calls, credentials or remote content in output.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMayConfig, parseMayConfig } from "../packages/config/dist/index.js";
import { namespaceMcpToolName } from "../packages/mcp/dist/index.js";
import { openConfiguredMaybeCode, executeMaybeCodeSlashCommand } from "../apps/maybecode/dist/index.js";

const unauthenticated = process.argv.includes("--unauthenticated");
const args = process.argv.slice(2).filter((arg) => arg !== "--unauthenticated");
if (args.length > 1) throw new Error("Usage: node scripts/test-maybecode-github-mcp.mjs [config-path] [--unauthenticated]");
const endpoint = "https://api.githubcopilot.com/mcp/readonly";
const toolName = namespaceMcpToolName("github", "get_file_contents");
const input = { owner: "github", repo: "github-mcp-server", path: "README.md", ref: "refs/heads/main" };
let phase = "configuration";
let directory, app, relay;

try {
  const saved = await loadMayConfig(args[0] ? { path: args[0] } : {});
  const entry = saved.apps?.maybecode?.mcpServers?.github;
  assert.ok(entry, "Install the GitHub entry documented in docs/en/guides/mcp.md first");
  // Never send a PAT to a user-edited destination or inherit unrelated servers/Host settings.
  assert.equal(entry.transport, "streamable-http");
  assert.equal(entry.url, endpoint);
  assert.deepEqual(entry.headers, { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" });
  assert.equal(entry.auth, undefined);
  if (!unauthenticated && !process.env.GITHUB_MCP_TOKEN?.trim()) {
    console.error("BLOCKED: set GITHUB_MCP_TOKEN locally; do not paste it into chat. No authenticated test ran.");
    process.exitCode = 2;
  } else {
    directory = await mkdtemp(join(tmpdir(), "may-github-mcp-"));
    const config = parseMayConfig({
      providers: { probe: { adapter: "deepseek-chat", apiKey: "unused-local-probe" } },
      models: { probe: { provider: "probe", model: "probe" } }, defaultModel: "probe",
      apps: { maybecode: { mcpServers: { github: {
        transport: entry.transport, url: entry.url,
        ...(unauthenticated ? {} : { headers: entry.headers }),
        enabled: true, required: false, protocolMode: "auto",
        requestTimeoutMs: 15000, maxTotalTimeoutMs: 20000,
      } } } },
    }, join(directory, "config.json"));
    let approvals = 0, completed = 0, failed = 0, projected = false;
    phase = "MaybeCode startup and discovery";
    app = await openConfiguredMaybeCode({
      workspace: directory, dataDirectory: join(directory, "data"), instructions: "GitHub read-only MCP smoke.",
      retry: false, observability: false, maxSteps: 2,
    }, { loadConfig: async () => config, createModel: () => ({ async *stream(request, { step }) {
      if (step === 1) assert.ok(request.tools.some((tool) => tool.name === toolName));
      else projected = request.messages.some((message) => message.role === "tool" &&
        message.toolCallId === "github-read" && !message.isError && message.content.length > 0);
      yield { type: "response.completed", message: { role: "assistant", content: [],
        ...(step === 1 ? { toolCalls: [{ id: "github-read", name: toolName, input }] } : {}),
      } };
    } }) });
    const status = await executeMaybeCodeSlashCommand("/mcp", app);
    assert.equal(status.type, "mcp.status");
    const server = status.servers.find((item) => item.serverId === "github");
    assert.ok(server);
    // Project diagnostics with HTTP bodies/headers removed; never dump raw responses.
    console.log(JSON.stringify({ server: "github", state: server.state, protocol: server.protocolVersion,
      toolCount: server.toolNames.length, diagnosticCode: server.diagnostic?.code,
      httpStatus: server.diagnostic?.message.match(/\b(?:401|403|404|429|5\d\d)\b/u)?.[0] }));
    if (unauthenticated) {
      assert.notEqual(server.state, "connected");
      assert.match(server.diagnostic?.message ?? "", /\b401\b/u);
      console.log("PASS: real MaybeCode startup survived optional-server HTTP 401. Authenticated discovery/call NOT tested.");
    } else {
      assert.equal(server.state, "connected");
      const catalog = app.getMcpCatalog().find((item) => item.serverId === "github");
      assert.ok(catalog?.tools.some((tool) => tool.name === "get_file_contents"));
      console.log(JSON.stringify({ advertisedCapabilities: Object.keys(catalog.capabilities),
        resources: catalog.resources.length, prompts: catalog.prompts.length }));
      phase = "permission and public README tool call";
      relay = (async () => {
        for await (const event of app.events) {
          if (event.type === "permission.event" && event.event.type === "approval.requested") {
            const request = event.event.request;
            const allow = approvals === 0 && request.tool.name === toolName && isDeepStrictEqual(request.input, input);
            if (allow) approvals++;
            await app.resolveApproval(request.id, allow ? "allow" : "deny");
          }
          if (event.type === "run.event" && event.event.call?.id === "github-read") {
            if (event.event.type === "tool.completed") completed++;
            if (event.event.type === "tool.failed") failed++;
          }
        }
      })();
      // Observe relay failures immediately rather than leaving a waiting approval hanging.
      const run = await app.submit({ input: "Read the public github/github-mcp-server README only.", signal: AbortSignal.timeout(45000) });
      await Promise.race([run.result, relay.then(() => { throw new Error("Event stream closed during Run"); })]);
      assert.equal(approvals, 1); assert.equal(completed, 1); assert.equal(failed, 0); assert.equal(projected, true);
      console.log("PASS: live discovery, one approved public read, and tool-result projection through MaybeCode. No provider API used.");
    }
  }
} catch {
  // Assertions/configuration/remote failures can contain secrets or content; do not print them.
  console.error(`FAIL during ${phase}. Check the documented entry, token permissions and endpoint availability; details withheld.`);
  process.exitCode = 1;
} finally {
  try { await app?.close(); await relay; }
  catch { console.error("FAIL: MaybeCode cleanup"); process.exitCode = 1; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
