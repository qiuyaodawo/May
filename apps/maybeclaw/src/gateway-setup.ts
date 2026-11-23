import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { parseMayConfig } from "@sortedyuan/may/config";
import { acquireFileLock, hasErrorCode, withFileAccess } from "@sortedyuan/may/storage";
import { UiError } from "@sortedyuan/ui-client";
import { authorized, secureHeaders, sendJson, trustedRequest } from "@sortedyuan/ui-client/server";
import { PostRenameDurabilityError, resolveConfigTargetPath, writeDurableIfUnchanged } from "./config-file-write.js";
import { gatewaySettings } from "./gateway-settings.js";
import { hashAdministratorPassword } from "./gateway-auth.js";

async function source(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function inspectGatewaySetup(path: string) {
  const targetPath = await resolveConfigTargetPath(path);
  let original: string | undefined;
  try {
    original = await withFileAccess(targetPath, "shared", () => source(targetPath));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  return parseGatewaySetup(targetPath, original);
}

function parseGatewaySetup(path: string, original: string | undefined) {
  let config: Record<string, unknown> = { providers: {} };
  if (original !== undefined) {
    try {
      const parsedJson: unknown = JSON.parse(original);
      if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
        throw new Error("配置文件需要有效的 JSON 对象。");
      }
      config = parsedJson as Record<string, unknown>;
    } catch {
      throw new Error("配置文件需要有效的 JSON。");
    }
  }
  const parsed = parseMayConfig(config, path);
  const raw = parsed.apps?.maybeclaw;
  if (raw && Object.keys(raw).length && raw.version !== 2)
    throw new Error("MaybeClaw 配置需要 version: 2。原配置保持不变。");
  const candidate: Record<string, unknown> = { version: 2, agents: [], ...raw };
  gatewaySettings({ ...parsed, apps: { ...parsed.apps, maybeclaw: candidate } });
  const needsSetup = candidate.server === undefined || (candidate.server as Record<string, unknown>).auth === undefined;
  return { original, config, candidate, needsSetup };
}

export async function startGatewaySetup(options: {
  path: string;
  port?: number;
  activate: (server: Server) => Promise<void>;
}) {
  const path = await resolveConfigTargetPath(options.path);
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireFileLock(`${path}.initialize.lock`);
  const launchPath = `${path}.${randomUUID()}.initialize.html`;
  const token = randomBytes(32).toString("base64url");
  let busy = false,
    consumed = false,
    transferred = false,
    released = false,
    closing: Promise<void> | undefined;
  let complete!: () => void, fail!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  let origin = "";
  const requests = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    let terminalFailure: unknown;
    let ownsCompletion = false;
    const work = (async () => {
      secureHeaders(res);
      if (!trustedRequest(req, origin)) throw new UiError(403, "请求来源无效。");
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page);
        return;
      }
      if (req.method === "GET" && req.url === "/setup.js") {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(script);
        return;
      }
      if (req.method === "GET" && req.url === "/setup.css") {
        res.setHeader("content-type", "text/css; charset=utf-8");
        res.end(style);
        return;
      }
      if (req.method !== "POST" || req.url !== "/api/setup") throw new UiError(404, "接口不存在。");
      if (consumed || !authorized(req, token)) throw new UiError(403, "初始化凭据无效或已经使用，请重新启动服务。");
      if (busy) throw new UiError(409, "初始化正在进行。");
      busy = true;
      try {
        if (req.headers["content-type"] !== "application/json") throw new UiError(400, "需要 JSON 请求。");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) throw new UiError(413, "请求过大。");
          chunks.push(Buffer.from(chunk));
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new UiError(400, "需要有效的 JSON 请求。");
        }
        if (
          !data ||
          Object.keys(data).some((key) => !["password", "confirmation"].includes(key)) ||
          data.password !== data.confirmation
        )
          throw new UiError(400, "两次输入的密码需要一致。");
        const passwordHash = await hashAdministratorPassword(data.password);
        if (closing) throw new UiError(503, "初始化服务正在关闭。");
        let postRenameFailure: PostRenameDurabilityError | undefined;
        const postRenameCleanupErrors: unknown[] = [];
        try {
          await withFileAccess(path, "exclusive", async () => {
            if (closing) throw new UiError(503, "初始化服务正在关闭。");
            const current = parseGatewaySetup(path, await source(path));
            if (!current.needsSetup) throw new UiError(409, "管理员密码已经配置，禁止重复初始化。");
            const config = current.config;
            const existingApps =
              typeof config.apps === "object" && config.apps !== null && !Array.isArray(config.apps)
                ? (config.apps as Record<string, unknown>)
                : {};
            config.apps = {
              ...existingApps,
              maybeclaw: {
                ...current.candidate,
                server: { ...(current.candidate.server as object), auth: { passwordHash } },
              },
            };
            gatewaySettings(parseMayConfig(config, path));
            const serialized = JSON.stringify(config, null, 2) + "\n";
            try {
              await writeDurableIfUnchanged(path, serialized, async () => {
                if ((await source(path)) !== current.original) {
                  throw new UiError(409, "配置已被其他操作修改，请重试。");
                }
              });
            } catch (error) {
              if (error instanceof PostRenameDurabilityError) {
                // Rename already succeeded; immediately claim setup completion ownership and
                // preserve the original durability error before any lock unlock or cleanup runs.
                consumed = true;
                ownsCompletion = true;
                postRenameFailure = error;
                terminalFailure = error;
                return;
              }
              throw error;
            }
          });
        } catch (error) {
          if (!postRenameFailure) throw error;
          postRenameCleanupErrors.push(error);
        }
        if (postRenameFailure) {
          try {
            await release();
          } catch (releaseError) {
            postRenameCleanupErrors.push(releaseError);
          }
          if (postRenameCleanupErrors.length > 0) {
            terminalFailure = new AggregateError(
              [postRenameFailure, ...postRenameCleanupErrors],
              postRenameFailure.message,
            );
          }
          throw new UiError(500, "管理员密码已写入但目录同步失败，请检查存储状态后重新启动控制台。");
        }
        consumed = true;
        ownsCompletion = true;
        try {
          await options.activate(server);
          transferred = true;
        } catch (error) {
          terminalFailure = error;
          throw error;
        }
        await release();
        sendJson(res, 200, { initialized: true });
        complete();
      } finally {
        busy = false;
      }
    })()
      .catch(async (error) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          const finished = new Promise<void>((resolve) => {
            res.once("finish", resolve);
            res.once("close", resolve);
          });
          sendJson(res, error instanceof UiError ? error.status : 400, {
            error: error instanceof Error ? error.message : "初始化失败。",
          });
          if (!res.writableFinished && !res.destroyed) await finished;
        }
        if (ownsCompletion) fail(terminalFailure ?? error);
      })
      .finally(() => requests.delete(work));
    requests.add(work);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 16;
  async function release() {
    if (released) return;
    released = true;
    try {
      await rm(launchPath, { force: true });
    } finally {
      await lock.release();
    }
  }
  try {
    if (!(await inspectGatewaySetup(path)).needsSetup) throw new Error("管理员密码已经配置，请直接启动控制台。");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 3939, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = `${origin}/#initialize=${token}`;
    await writeFile(
      launchPath,
      `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${url}"><title>MaybeClaw 初始化</title>`,
      { flag: "wx", mode: 0o600 },
    );
    return {
      url,
      launchPath,
      completed,
      close: () =>
        (closing ??= (async () => {
          if (!transferred) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            await Promise.allSettled([...requests]);
            await release();
          }
        })()),
    };
  } catch (error) {
    server.close();
    await release();
    throw error;
  }
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MaybeClaw 初始化</title><link rel="stylesheet" href="/setup.css"><main><h1>设置 MaybeClaw 管理员密码</h1><p>设置密码后进入控制台，添加 Agent 并创建会话。</p><form><p><label>管理员密码 <input name="password" type="password" minlength="10" maxlength="1024" autocomplete="new-password" required></label></p><p>密码长度为 10 至 1024 个字符。</p><p><label>确认密码 <input name="confirmation" type="password" minlength="10" maxlength="1024" autocomplete="new-password" required></label></p><button>完成初始化</button><p role="alert"></p></form></main><script src="/setup.js"></script></html>`;
const style = `:root{font-family:system-ui,sans-serif;color:#172337;background:#f3f5f9}body{margin:0;padding:24px}main{max-width:480px;margin:8vh auto;padding:32px;background:white;border:1px solid #dae0e9;border-radius:16px}h1{font-size:24px}p{line-height:1.6}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px;border:1px solid #b7c2d3;border-radius:8px}input{display:block;margin-top:8px}button{background:#244ec9;color:white;cursor:pointer}button:disabled{opacity:.6;cursor:default}[role=alert]{color:#a11b23;overflow-wrap:anywhere}@media(max-width:520px){main{margin:24px auto;padding:20px}}`;
const script = `const token = new URLSearchParams(location.hash.slice(1)).get("initialize");
history.replaceState(null, "", "/");
const form = document.querySelector("form"), button = document.querySelector("button"), error = document.querySelector('[role="alert"]');
if (!token) { error.textContent = "请通过启动时自动打开的页面，或终端提示的本机初始化文件访问。"; button.disabled = true; }
form.addEventListener("submit", async event => {
  event.preventDefault(); button.disabled = true; error.textContent = "";
  try {
    const response = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ password: form.elements.password.value, confirmation: form.elements.confirmation.value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    form.reset(); location.replace("/");
  } catch (reason) { error.textContent = reason.message; button.disabled = false; }
});`;
