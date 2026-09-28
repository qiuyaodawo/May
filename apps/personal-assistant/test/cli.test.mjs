import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function createHome() {
  const root = await mkdtemp(join(tmpdir(), "may-assistant-cli-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    providers: { local: { adapter: "openai-chat-completions", apiKeyEnv: "MAY_ASSISTANT_TEST_KEY", baseURL: "http://127.0.0.1:1/v1" } },
    models: { local: { provider: "local", model: "test-model" } },
    defaultModel: "local",
  }, null, 2));
  return { root, configPath };
}

function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], { env: { ...process.env, ...options.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("帮助信息列出全部命令", { timeout: 30_000 }, async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  for (const command of ["serve", "status", "mail check", "mail confirm", "ehall review", "index", "rules"]) {
    assert.match(result.stdout, new RegExp(command.replace(" ", " "), "u"));
  }
  assert.match(result.stdout, /MAY_ASSISTANT_MAIL_PASSWORD/u);
});

test("未知命令与未知选项返回用法错误", { timeout: 30_000 }, async () => {
  const unknown = await run(["nope"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知命令：nope/u);

  const option = await run(["status", "--nope"]);
  assert.equal(option.code, 2);
  assert.match(option.stderr, /未知选项：--nope/u);

  const missing = await run(["mail", "confirm"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /需要草稿编号/u);
});

test("status 输出数据目录、数据库与邮箱状态", { timeout: 30_000 }, async () => {
  const { root, configPath } = await createHome();
  const result = await run(["status", "--config", configPath, "--home", root]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(result.stdout, /个人数据库：/u);
  assert.match(result.stdout, /邮箱：未配置/u);
  assert.match(result.stdout, /监听：127\.0\.0\.1:3946/u);
  assert.ok((await readFile(join(root, "vault", "ehall", "services.md"), "utf8")).includes("transcript"));
});

test("index 建立索引并提交 Git，rules 列出规则", { timeout: 60_000 }, async () => {
  const { root, configPath } = await createHome();
  const first = await run(["index", "--config", configPath, "--home", root]);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /共 \d+ 个文件/u);

  await mkdir(join(root, "vault", "notes"), { recursive: true });
  await writeFile(join(root, "vault", "notes", "one.md"), "---\ntitle: 第一条\n---\n\n内容\n");
  const second = await run(["index", "--config", configPath, "--home", root]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /共 3 个文件/u);
  const third = await run(["index", "--config", configPath, "--home", root]);
  assert.match(third.stdout, /没有需要提交的改动/u);

  const rules = await run(["rules", "--config", configPath, "--home", root]);
  assert.equal(rules.code, 0);
  assert.match(rules.stdout, /还没有记录规则/u);
});

test("mail drafts 与 mail show 在没有草稿时给出明确提示", { timeout: 60_000 }, async () => {
  const { root, configPath } = await createHome();
  const drafts = await run(["mail", "drafts", "--config", configPath, "--home", root]);
  assert.equal(drafts.code, 0);
  assert.match(drafts.stdout, /没有草稿/u);

  const show = await run(["mail", "show", "d000", "--config", configPath, "--home", root]);
  assert.equal(show.code, 1);
  assert.match(show.stderr, /草稿不存在/u);

  const check = await run(["mail", "check", "--config", configPath, "--home", root]);
  assert.equal(check.code, 1);
  assert.match(check.stderr, /没有配置邮箱/);
});

test("ehall services 列出事务与不可撤销标记", { timeout: 60_000 }, async () => {
  const { root, configPath } = await createHome();
  const result = await run(["ehall", "services", "--config", configPath, "--home", root]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /transcript · 成绩单打印申请/u);
  assert.match(result.stdout, /course-withdraw · 退课申请 · 教学 · 不可撤销（不提供提交）/u);
  assert.match(result.stdout, /提交按钮「提交申请」/u);
});

test("allow-lan 必须同时指定局域网地址", { timeout: 30_000 }, async () => {
  const { root, configPath } = await createHome();
  const result = await run(["serve", "--config", configPath, "--home", root, "--allow-lan"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /必须指定 server\.host/u);
});

test("serve 启动工作台并打印连接链接，收到中断后退出", { timeout: 60_000 }, async () => {
  const requests = [];
  const provider = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"index":0,"delta":{"content":"已收到"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${provider.address().port}/v1`;
  const { root, configPath } = await createHome();
  await writeFile(configPath, JSON.stringify({
    providers: { local: { adapter: "openai-chat-completions", apiKeyEnv: "MAY_ASSISTANT_TEST_KEY", baseURL } },
    models: { local: { provider: "local", model: "test-model" } },
    defaultModel: "local",
  }));

  const child = spawn(process.execPath, [binPath, "serve", "--config", configPath, "--home", root, "--port", "0"], {
    env: { ...process.env, MAY_ASSISTANT_TEST_KEY: "test-key", MAY_ASSISTANT_CONTROL_TOKEN: "control-token-for-tests-0123456789abcdef" },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务没有打印地址：${stdout}`)), 30_000);
      const check = setInterval(() => {
        const match = /个人助手工作台：(http:\/\/\S+)/u.exec(stdout);
        if (match !== null) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(match[1]);
        }
      }, 50);
    });
    assert.match(stdout, /一次性票据/u);
    assert.match(stdout, /关掉浏览器页面不会停止助手/u);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /个人助手/);

    const unauthorized = await fetch(`${url}/api/ui/snapshot`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${url}/api/ui/snapshot`, {
      headers: { authorization: "Bearer control-token-for-tests-0123456789abcdef" },
    });
    assert.equal(authorized.status, 200);
    const state = await authorized.json();
    assert.equal(state.product.id, "personal-assistant");

    const ticket = /#may-connect=(\S+)/u.exec(stdout)?.[1];
    assert.ok(ticket, "应当打印一次性票据");
    const exchanged = await fetch(`${url}/api/ui/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    assert.equal(exchanged.status, 200);
    assert.equal((await exchanged.json()).token, "control-token-for-tests-0123456789abcdef");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));
    await new Promise((resolve) => provider.close(resolve));
  }
});
