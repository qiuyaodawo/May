import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const workspacePath = fileURLToPath(new URL("../../..", import.meta.url));

test("runs the built CLI through config, DeepSeek, and May", {
  timeout: 30_000,
}, async (t) => {
  let request;
  const baseURL = await startServer(t, async (incoming, response) => {
    request = {
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
      contentType: incoming.headers["content-type"],
      body: JSON.parse(await readBody(incoming)),
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse([
      {
        choices: [{
          index: 0,
          delta: { reasoning_content: "Think." },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { content: "Answer." },
          finish_reason: null,
        }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      },
      "[DONE]",
    ]));
  });
  const configPath = await writeConfig(t, {
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKeyEnv: "MAY_CLI_TEST_API_KEY",
        baseURL,
        options: {
          thinking: "enabled",
          reasoningEffort: "high",
          maxTokens: 1234,
        },
      },
    },
    models: {
      deepseek: { provider: "deepseek", model: "deepseek-test-model" },
    },
    defaultModel: "deepseek",
  });

  const result = await runProcess([
    "run",
    "--config",
    configPath,
    "Hello",
    "May",
  ], {
    MAY_CLI_TEST_API_KEY: "local-test-key",
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "Answer.\n");
  assert.equal(result.stderr, "Think.\n");
  assert.deepEqual(request, {
    method: "POST",
    url: "/chat/completions",
    authorization: "Bearer local-test-key",
    contentType: "application/json",
    body: {
      model: "deepseek-test-model",
      messages: [{ role: "user", content: "Hello May" }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 1234,
    },
  });
});

test("returns a clean process error for DeepSeek HTTP failures", {
  timeout: 30_000,
}, async (t) => {
  const baseURL = await startServer(t, async (request, response) => {
    await readBody(request);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: "Test authentication failed",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    }));
  });
  const configPath = await writeConfig(t, {
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKey: "test-key",
        baseURL,
      },
    },
    models: {
      deepseek: { provider: "deepseek", model: "deepseek-test-model" },
    },
    defaultModel: "deepseek",
  });

  const result = await runProcess([
    "run",
    "--config",
    configPath,
    "Hello",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Error: Test authentication failed\n");
});

async function startServer(t, handleRequest) {
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function writeConfig(t, config) {
  const directory = await mkdtemp(join(tmpdir(), "may-cli-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(values) {
  return values
    .map((value) =>
      `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`
    )
    .join("");
}

function runProcess(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: workspacePath,
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error("CLI process did not exit within 10 seconds"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
