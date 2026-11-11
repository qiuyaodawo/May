import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import which from "which";
import type { CodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import type { LanguageServerDefinition } from "./types.js";
import { LspServerNotFoundError } from "./errors.js";

/** @experimental */
export const LANGUAGE_SERVER_PRESETS = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: {
      typescript: [".ts", ".mts", ".cts"],
      typescriptreact: [".tsx"],
      javascript: [".js", ".mjs", ".cjs"],
      javascriptreact: [".jsx"],
    },
    package: "typescript-language-server",
    install: "npm install -g typescript-language-server typescript",
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: { python: [".py", ".pyi"] },
    package: "pyright",
    install: "npm install -g pyright",
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: { rust: [".rs"] },
    install: "rustup component add rust-analyzer rust-src",
  },
  go: { command: "gopls", args: [], languages: { go: [".go"] }, install: "go install golang.org/x/tools/gopls@latest" },
} as const;

export function serverDefinition(input: LanguageServerDefinition): LanguageServerDefinition & {
  command: string;
  languages: Readonly<Record<string, readonly string[]>>;
  args: readonly string[];
} {
  const preset = LANGUAGE_SERVER_PRESETS[input.id as keyof typeof LANGUAGE_SERVER_PRESETS];
  const definition = { ...preset, ...input };
  if (!definition.command || !definition.languages)
    throw new TypeError(`Server ${input.id} requires command and languages`);
  return { ...definition, command: definition.command, languages: definition.languages, args: definition.args ?? [] };
}

async function npmScript(manifest: string, command: string): Promise<string> {
  const value = JSON.parse(await readFile(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof value.bin === "string" ? value.bin : value.bin?.[command];
  if (!bin) throw new LspServerNotFoundError(`No bin ${command} in ${manifest}`);
  return resolve(dirname(manifest), bin);
}

export async function resolveServerCommand(
  definition: ReturnType<typeof serverDefinition>,
  execution: CodingExecutionEnvironment,
): Promise<{ command: string; args: readonly string[] }> {
  const preset = LANGUAGE_SERVER_PRESETS[definition.id as keyof typeof LANGUAGE_SERVER_PRESETS];
  const packageName =
    preset && "package" in preset && definition.command === preset.command ? preset.package : undefined;
  const searched: string[] = [];
  if (packageName) {
    const manifestName = `${packageName}/package.json`;
    searched.push(join(execution.workspace, "node_modules", manifestName));
    let manifest: string | undefined;
    try {
      manifest = createRequire(join(execution.workspace, "package.json")).resolve(manifestName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
    if (manifest) {
      const script = await npmScript(manifest, definition.command);
      return {
        command: execution.isolation.mode === "host" ? process.execPath : "node",
        args: [execution.isolation.mode === "host" ? script : execution.toEnvironmentPath(script), ...definition.args],
      };
    }
  }
  if (execution.isolation.mode === "container") {
    const controller = new AbortController();
    const child = execution.spawn("sh", ["-c", 'command -v "$1"', "sh", definition.command], {
      cwd: execution.workspace,
      signal: controller.signal,
    });
    let output = "";
    child.stdout!.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    if (code === 0 && output.trim()) return { command: output.trim(), args: definition.args };
    searched.push(`container PATH: ${definition.command}`);
  } else {
    searched.push(`PATH: ${definition.command}`);
    const command = await which(definition.command, { nothrow: true });
    if (command) {
      if (process.platform === "win32" && /\.cmd$/iu.test(command)) {
        if (!packageName)
          throw new LspServerNotFoundError(`Cannot launch npm .cmd without a known package: ${command}`);
        const manifest = join(dirname(command), "node_modules", packageName, "package.json");
        searched.push(manifest);
        try {
          return {
            command: process.execPath,
            args: [await npmScript(manifest, definition.command), ...definition.args],
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else return { command, args: definition.args };
    }
  }
  throw new LspServerNotFoundError(
    `Server ${definition.id} not found. Searched: ${searched.join(", ")}. Install: ${preset?.install ?? definition.command}`,
  );
}
