import type { ApplicationUiHost } from "@sortedyuan/ui-client/application";
import { startUiServer } from "@sortedyuan/ui-client/server";
import { webUiAssets } from "@sortedyuan/web-ui/assets";
import { readFile } from "node:fs/promises";

export async function startMaybeCodeWebServer(host: ApplicationUiHost, options: { token: string; port?: number; browserLogin?: boolean; exit?: () => void }) {
  const extensionModule = await readFile(new URL("./web-extension.js", import.meta.resolve("@sortedyuan/maybecode")), "utf8");
  const diffBundle = await readFile(new URL("./dist/diff.js", import.meta.resolve("diff/package.json")), "utf8");
  const diffEsm = `${diffBundle}\nexport const { parsePatch } = globalThis.Diff;\n`;
  const assets = new Map(await webUiAssets("MaybeCode", "session", { extensionModule, ...(options.browserLogin === undefined ? {} : { browserLogin: options.browserLogin }) }));
  assets.set("/vendor-diff.js", { type: "text/javascript; charset=utf-8", body: diffEsm });
  return startUiServer({ host, assets, ...options, close: () => host.close() });
}
