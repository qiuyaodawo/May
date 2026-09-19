import { readFile } from "node:fs/promises";
import type { UiAssets } from "@may/ui-client/server";

/** Native ES modules, no CDN, runtime transpilation, inline scripts or application imports. */
export async function webUiAssets(title: string, kind: "session" | "task", options: { readonly extensionModule?: string; readonly browserLogin?: boolean } = {}): Promise<UiAssets> {
  const escaped = title.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const assets = new Map<string, { type: string; body: string }>();
  assets.set("/", { type: "text/html; charset=utf-8", body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escaped} · May ${kind === "task" ? "任务工作台" : "工作台"}</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="app" data-title="${escaped}" data-kind="${kind}"></div><noscript>工作台需要启用 JavaScript。</noscript></body></html>` });
  assets.set("/app.css", { type: "text/css; charset=utf-8", body: await readFile(new URL("../assets/workbench.css", import.meta.url), "utf8") });
  assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: `${options.extensionModule === undefined ? "const extensions = {};" : 'import { extensions } from "/product.js";'} import { UiClient } from "/ui/client.js"; import { mountWebUI } from "/webui/index.js"; ${options.browserLogin ? 'import { browserLogin } from "/webui/browser-login.js";' : ""} const root = document.getElementById("app"); mountWebUI(root, new UiClient(), { title: root.dataset.title, kind: root.dataset.kind, extensions${options.browserLogin ? ', initialToken: browserLogin(), connectionHint: "在终端重新打开 Web UI，即可连接当前会话。"' : ""} });` });
  if (options.extensionModule !== undefined) assets.set("/product.js", { type: "text/javascript; charset=utf-8", body: options.extensionModule });
  for (const name of ["index", "components", "markdown", "reading", "browser-login", "commands"]) assets.set(`/webui/${name}.js`, { type: "text/javascript; charset=utf-8", body: await readFile(new URL(`./${name}.js`, import.meta.url), "utf8") });
  const client = new URL(import.meta.resolve("@may/ui-client"));
  for (const name of ["client", "protocol"]) assets.set(`/ui/${name}.js`, { type: "text/javascript; charset=utf-8", body: await readFile(new URL(`./${name}.js`, client), "utf8") });
  return assets;
}
