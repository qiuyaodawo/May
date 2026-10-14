import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repository = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(repository, "apps/maybecode/dist");
const chunks = resolve(output, "cli");
if (dirname(chunks) !== output) throw new Error("CLI chunk directory is outside the application output");
await rm(chunks, { recursive: true, force: true });
await build({
  absWorkingDir: repository,
  entryPoints: ["apps/maybecode/src/bin.ts"],
  outdir: "apps/maybecode/dist",
  chunkNames: "cli/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.16",
  sourcemap: true,
  keepNames: true,
  // Core 和 Plugin 与外部插件共享模块身份；原生绑定和资源文件保留独立加载。
  external: [
    "@may/core", "@may/plugin", "@may/plugin-services", "@may/web-ui", "@may/media",
    "@napi-rs/keyring", "open", "clipboardy",
  ],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
