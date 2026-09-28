import { readFile } from "node:fs/promises";
import { webUiAssets } from "@may/web-ui/assets";
import type { UiAssets } from "@may/ui-client/server";

const PANEL_STYLES = `.assistant-panel{display:flex;flex-direction:column;gap:8px;padding:8px 4px;font-size:13px}
.assistant-status{margin:0;white-space:pre-line;color:var(--muted,#666);line-height:1.5}
.assistant-actions{display:flex;flex-wrap:wrap;gap:6px}
.assistant-actions .sidebar-nav-item{font-size:13px;padding:6px 10px}
.assistant-meta{margin:4px 0;color:var(--muted,#666);word-break:break-all}
.assistant-message{margin:0;min-height:1.2em;color:var(--accent,#0366d6)}
.assistant-card{border:1px solid var(--border,#e3e3e3);border-radius:8px;padding:8px;margin-bottom:8px}
.assistant-editor{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px;border:1px solid var(--border,#ccc);border-radius:6px}
.assistant-table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0}
.assistant-table td{border-top:1px solid var(--border,#e3e3e3);padding:4px 2px;vertical-align:top;word-break:break-all}`;

/**
 * 工作台资源：共享的 @may/web-ui 界面，加上助手自己的控制面板。
 * 面板代码来自 src/web-panel.ts，编译后作为浏览器 ES 模块提供。
 */
export async function assistantWebAssets(title: string, browserLogin: boolean): Promise<UiAssets> {
  const panel = await readFile(new URL("../web-panel.js", import.meta.url), "utf8");
  const assets = new Map(await webUiAssets(title, "session", { browserLogin }));
  assets.set("/assistant-panel.js", { type: "text/javascript; charset=utf-8", body: panel });
  assets.set("/assistant.css", { type: "text/css; charset=utf-8", body: PANEL_STYLES });
  assets.set("/app.js", {
    type: "text/javascript; charset=utf-8",
    body: [
      'import { UiClient } from "/ui/client.js";',
      'import { mountWebUI } from "/webui/index.js";',
      'import { createAssistantPanel } from "/assistant-panel.js";',
      ...(browserLogin ? ['import { browserLogin } from "/webui/browser-login.js";'] : []),
      "const root = document.getElementById(\"app\");",
      "const client = new UiClient();",
      "const panel = createAssistantPanel(client);",
      "mountWebUI(root, client, {",
      "  title: root.dataset.title,",
      "  kind: root.dataset.kind,",
      "  navigation: { render: (container, context) => {",
      "    container.append(panel.element);",
      "    return { update: (state) => panel.update(state) };",
      "  } },",
      ...(browserLogin
        ? ['  initialToken: browserLogin(),', '  connectionHint: "在终端重新运行 may-assistant serve 即可再次连接当前会话。",']
        : []),
      "});",
    ].join("\n"),
  });
  return assets;
}
