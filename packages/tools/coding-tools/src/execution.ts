import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { omitUndefined } from "@sortedyuan/may/core";
import { CodingToolError } from "./errors.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

/** @experimental */
export type CodingExecutionIsolation =
  | { readonly mode: "host" }
  | {
      readonly mode: "container";
      readonly image: string;
      readonly network: "none";
      readonly memoryBytes: number;
      readonly cpuCount: number;
    };

/** @experimental */
export interface CodingExecutionEnvironment {
  readonly workspace: string;
  readonly isolation: CodingExecutionIsolation;
  spawn(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly env?: Readonly<Record<string, string>>;
    },
  ): ChildProcess;
  close(): Promise<void>;
}

const containerWorkspace = "/workspace";
const supervisor =
  'setsid "$@" </dev/null & pid=$!; (read -r cancel; kill -KILL -- -"$pid") <&0 & monitor=$!; wait "$pid"; status=$?; kill -KILL -- -"$pid" 2>/dev/null; kill "$monitor"; wait "$monitor" 2>/dev/null; while kill -0 -- -"$pid" 2>/dev/null; do sleep 0.01; done; exit "$status"';

interface ProcessRecord {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  readonly stop: () => void;
  readonly stopping: Promise<void>[];
}

/** @experimental */
export async function openCodingExecutionEnvironment(options: {
  readonly workspace: string;
  readonly isolation: CodingExecutionIsolation;
  readonly signal?: AbortSignal;
}): Promise<CodingExecutionEnvironment> {
  options.signal?.throwIfAborted();
  const workspace = (await resolveExistingWorkspacePath(options.workspace, ".")).absolute;
  const isolation = Object.freeze({ ...options.isolation });
  const name = `may-${randomUUID()}`;
  if (isolation.mode === "container") {
    if (
      isolation.image.trim() === "" ||
      isolation.network !== "none" ||
      !Number.isSafeInteger(isolation.memoryBytes) ||
      isolation.memoryBytes <= 0 ||
      !Number.isFinite(isolation.cpuCount) ||
      isolation.cpuCount <= 0
    ) {
      throw new CodingToolError(
        "CODING_EXECUTION_INVALID_OPTIONS",
        "Container execution requires an image, network none, positive memoryBytes and cpuCount",
      );
    }
    await docker(["version", "--format", "{{.Server.Version}}"]);
    await docker(["image", "inspect", isolation.image]);
    options.signal?.throwIfAborted();
    const uid = process.platform === "win32" ? "1000:1000" : `${process.getuid!()}:${process.getgid!()}`;
    await docker([
      "create",
      "--init",
      "--name",
      name,
      "--pull",
      "never",
      "--user",
      uid,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=67108864",
      "--network",
      "none",
      "--memory",
      String(isolation.memoryBytes),
      "--memory-swap",
      String(isolation.memoryBytes),
      "--cpus",
      String(isolation.cpuCount),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,source=${workspace},target=${containerWorkspace}`,
      "--workdir",
      containerWorkspace,
      "--entrypoint",
      "bash",
      isolation.image,
      "-c",
      "trap 'exit 0' TERM INT; while :; do sleep 2147483647 & wait $!; done",
    ]);
    let started = false;
    try {
      await docker(["start", name]);
      started = true;
    } finally {
      if (!started) await docker(["rm", "--force", name]);
    }
  }
  const records = new Set<ProcessRecord>();
  const terminations = new Set<Promise<void>>();
  let terminationFailure: unknown;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    closePromise = (async () => {
      for (const record of records) record.stop();
      if (isolation.mode === "container") await docker(["rm", "--force", name]);
      await Promise.all(
        [...records].map(async (record) => {
          await record.done;
          await Promise.all(record.stopping);
        }),
      );
      await Promise.all(terminations);
      if (terminationFailure !== undefined) throw terminationFailure;
    })();
    return closePromise;
  };
  let abortFailure: unknown;
  const abort = () => {
    close().then(undefined, (error: unknown) => {
      abortFailure = error;
    });
  };
  const environment: CodingExecutionEnvironment = {
    workspace,
    isolation,
    spawn(command, args, spawnOptions) {
      if (closed) throw new CodingToolError("CODING_EXECUTION_CLOSED", "Execution environment is closed");
      spawnOptions.signal.throwIfAborted();
      const path = relative(workspace, realpathSync(resolve(spawnOptions.cwd)));
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new CodingToolError("CODING_TOOL_PATH_OUTSIDE_WORKSPACE", "Execution cwd is outside the workspace");
      }
      const containerCwd = path === "" ? containerWorkspace : `${containerWorkspace}/${path.split(sep).join("/")}`;
      const dockerArgs = ["exec", "--interactive", "--workdir", containerCwd];
      for (const [key, value] of Object.entries(spawnOptions.env ?? {})) dockerArgs.push("--env", `${key}=${value}`);
      dockerArgs.push(name, "bash", "-c", supervisor, "may-exec", command, ...args);
      const child =
        isolation.mode === "host"
          ? spawn(
              command,
              [...args],
              omitUndefined({
                cwd: spawnOptions.cwd,
                env: spawnOptions.env,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: "pipe" as const,
              }),
            )
          : spawn("docker", dockerArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stopping: Promise<void>[] = [];
      child.stdin?.on("error", (error: Error) => {
        terminationFailure = error;
      });
      let stopped = false;
      const stop = () => {
        if (stopped || child.exitCode !== null || child.signalCode !== null) return;
        stopped = true;
        if (isolation.mode === "container") {
          child.stdin?.end("cancel\n");
        } else if (child.pid !== undefined) {
          const killer =
            process.platform === "win32"
              ? spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
              : spawn("kill", ["-KILL", "--", `-${child.pid}`], { stdio: "ignore" });
          const termination = new Promise<void>((resolveStop) => {
            killer.once("error", (error) => {
              terminationFailure = error;
            });
            killer.once("close", () => resolveStop());
          });
          stopping.push(termination);
          terminations.add(termination);
        }
      };
      const done = new Promise<void>((resolveDone) => {
        child.once("error", (error) => {
          terminationFailure = error;
        });
        child.once("close", () => {
          spawnOptions.signal.removeEventListener("abort", stop);
          records.delete(record);
          resolveDone();
        });
      });
      const record = { child, done, stop, stopping };
      records.add(record);
      spawnOptions.signal.addEventListener("abort", stop, { once: true });
      if (spawnOptions.signal.aborted) stop();
      return child;
    },
    async close() {
      await close();
      if (abortFailure !== undefined) throw abortFailure;
    },
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (isolation.mode === "container") {
    const probe = environment.spawn(
      "bash",
      ["-c", "command -v bash && command -v git && command -v rg && command -v setsid"],
      { cwd: workspace, signal: options.signal ?? new AbortController().signal },
    );
    let ready = false;
    try {
      const result = await processResult(probe);
      if (result.code !== 0)
        throw new CodingToolError(
          "CODING_EXECUTION_IMAGE_INVALID",
          `Container image must provide bash, git, rg, and setsid: ${result.stderr}`,
        );
      ready = true;
    } finally {
      if (!ready) await close();
    }
  }
  if (options.signal?.aborted) {
    await environment.close();
    options.signal.throwIfAborted();
  }
  options.signal?.removeEventListener("abort", abort);
  return environment;
}

async function docker(args: readonly string[]): Promise<void> {
  const result = await processResult(
    spawn("docker", [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
  );
  if (result.code !== 0)
    throw new CodingToolError("CODING_EXECUTION_DOCKER_FAILED", `docker ${args[0]} failed: ${result.stderr}`);
}

function processResult(child: ChildProcess): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) =>
      rejectResult(
        new CodingToolError("CODING_EXECUTION_DOCKER_FAILED", `Unable to start Docker: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    child.once("close", (code) => resolveResult({ code, stderr }));
  });
}
