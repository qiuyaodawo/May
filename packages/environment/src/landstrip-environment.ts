import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { binaryPath as landstripBinaryPath } from "@landstrip/landstrip-api";
import {
  createOutputCollector,
  runCommand,
  startCommand,
} from "./command.js";
import { EnvironmentError } from "./errors.js";
import { assertArtifactReference } from "./internal.js";
import {
  EnvironmentProcessHandle,
  DEFAULT_PROCESS_CANCEL_GRACE_MS,
  DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
} from "./process.js";
import { joinPath, resolveEnvironmentPath } from "./paths.js";
import { FULL_ENVIRONMENT_CAPABILITIES, renderIsolationSummary } from "./artifact.js";
import type {
  EnvironmentArtifactExport,
  EnvironmentArtifactReference,
  EnvironmentCapabilities,
  EnvironmentCloseOptions,
  EnvironmentCloseReport,
  EnvironmentDirectoryEntry,
  EnvironmentDirectoryListing,
  EnvironmentDescription,
  EnvironmentEntryType,
  EnvironmentExportArtifactOptions,
  EnvironmentFileContents,
  EnvironmentFileStat,
  EnvironmentListDirectoryOptions,
  EnvironmentMakeDirectoryOptions,
  EnvironmentPathOperationOptions,
  EnvironmentProcess,
  EnvironmentProcessOptions,
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentProgramRequirement,
  EnvironmentProvider,
  EnvironmentReadArtifactOptions,
  EnvironmentReadFileOptions,
  EnvironmentRemoveDirectoryOptions,
  EnvironmentResourceLimits,
  EnvironmentResourceOwnership,
  EnvironmentStatus,
  EnvironmentWriteFileOptions,
} from "./types.js";

export const LANDSTRIP_PROVIDER_ID = "@may/environment/landstrip";

/** 合并资源限制，拒绝非法取值。 */
function resolveLimits(
  provided: Partial<EnvironmentResourceLimits> | undefined,
): EnvironmentResourceLimits {
  const limits: EnvironmentResourceLimits = { ...DEFAULT_LIMITS, ...(provided ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new EnvironmentError(
        "ENVIRONMENT_INVALID_OPTION",
        `resource limit ${name} must be a positive integer, received ${String(value)}`,
      );
    }
  }
  return limits;
}

/**
 * 隔离程序启动时需要的宿主系统变量白名单，只取这几个值，不继承宿主环境。
 */
function hostSystemEnvironment(): Record<string, string> {
  const required = ["SystemRoot", "windir", "ComSpec", "ProgramData", "LOCALAPPDATA"];
  const values: Record<string, string> = {};
  for (const name of required) {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new EnvironmentError(
        "ENVIRONMENT_PROVIDER_UNAVAILABLE",
        `the host must provide ${name} so the sandbox can start system programs`,
      );
    }
    values[name] = value;
  }
  const windowsDirectory = values["windir"] ?? values["SystemRoot"] ?? "C:\\Windows";
  values.PATH = [
    join(windowsDirectory, "System32"),
    windowsDirectory,
    join(windowsDirectory, "System32", "Wbem"),
    join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  return values;
}

export interface LandstripEnvironmentOptions {
  /** 宿主工作区目录，默认允许读取和写入。 */
  readonly workspace: string;
  /** 额外的可读目录，例如隔离实现需要的运行目录。 */
  readonly readablePaths?: readonly string[];
  /** 可写目录，默认只有工作区。 */
  readonly writablePaths?: readonly string[];
  /** 显式拒绝读取的目录。 */
  readonly deniedReadPaths?: readonly string[];
  /** 显式拒绝写入的目录。 */
  readonly deniedWritePaths?: readonly string[];
  /** 隔离内网络状态，默认 none。 */
  readonly network?: "none" | "allow";
  /** 隔离实现的访问强度，默认 standard。 */
  readonly appContainerMode?: "standard" | "lpac";
  readonly displayName?: string;
  /** landstrip 可执行文件路径，默认使用依赖自带的二进制。 */
  readonly binary?: string;
  /** 注入到命令与文件操作中的环境变量。 */
  readonly environment?: Readonly<Record<string, string>>;
  /** 环境内必须存在的程序，创建时逐一验证。 */
  readonly requiredPrograms?: readonly EnvironmentProgramRequirement[];
  /** 资源限制，不设置时使用默认值。 */
  readonly limits?: Partial<EnvironmentResourceLimits>;
  readonly signal?: AbortSignal;
  /** Node 默认启用符号链接保留参数，默认 true。 */
  readonly nodePreserveSymlinks?: boolean;
}

const DEFAULT_LIMITS: EnvironmentResourceLimits = {
  maxConcurrentProcesses: 16,
  maxOutputBytesPerProcess: DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
  processTimeoutMs: DEFAULT_PROCESS_TIMEOUT_MS,
  maxFileBytes: 16 * 1024 * 1024,
};

interface ActiveEntry {
  readonly handle: EnvironmentProcessHandle;
}

/**
 * 使用 landstrip 提供的操作系统级隔离创建的执行环境。
 */
class LandstripEnvironment implements EnvironmentProvider {
  readonly providerId = LANDSTRIP_PROVIDER_ID;
  readonly displayName: string;
  readonly environmentId: string;

  readonly #binary: string;
  readonly #agentPolicyPath: string;
  readonly #fileOperationPolicyPath: string;
  readonly #stateDirectory: string;
  readonly #workspace: string;
  readonly #workingDirectory: string;
  readonly #options: LandstripEnvironmentOptions;
  readonly #readableRoots: readonly string[];
  readonly #writableRoots: readonly string[];
  readonly #baseEnvironment: Readonly<Record<string, string>>;
  readonly #runtimeDirectory: string;
  readonly #script: string;
  readonly #limits: EnvironmentResourceLimits;
  readonly #nodePreserveSymlinks: boolean;
  readonly #startedAt = new Date().toISOString();
  readonly #active = new Map<string, ActiveEntry>();
  readonly #stateListeners = new Set<(status: EnvironmentStatus) => void>();
  readonly #ownership: EnvironmentResourceOwnership;
  readonly #description: EnvironmentDescription;
  #state: EnvironmentStatus["state"] = "ready";
  #counter = 0;
  #closeReport: EnvironmentCloseReport | undefined;
  #closePromise: Promise<EnvironmentCloseReport> | undefined;

  constructor(init: {
    readonly options: LandstripEnvironmentOptions;
    readonly binary: string;
    readonly workspace: string;
    readonly stateDirectory: string;
    readonly agentPolicyPath: string;
    readonly fileOperationPolicyPath: string;
    readonly readableRoots: readonly string[];
    readonly writableRoots: readonly string[];
    readonly baseEnvironment: Readonly<Record<string, string>>;
    readonly runtimeDirectory: string;
    readonly script: string;
    readonly limits: EnvironmentResourceLimits;
    readonly environmentId: string;
  }) {
    this.#options = init.options;
    this.#binary = init.binary;
    this.#workspace = init.workspace;
    this.#workingDirectory = init.workspace;
    this.#stateDirectory = init.stateDirectory;
    this.#agentPolicyPath = init.agentPolicyPath;
    this.#fileOperationPolicyPath = init.fileOperationPolicyPath;
    this.#readableRoots = init.readableRoots;
    this.#writableRoots = init.writableRoots;
    this.#baseEnvironment = init.baseEnvironment;
    this.#runtimeDirectory = init.runtimeDirectory;
    this.#script = init.script;
    this.#limits = init.limits;
    this.#nodePreserveSymlinks = init.options.nodePreserveSymlinks ?? true;
    this.environmentId = init.environmentId;
    this.displayName = init.options.displayName ?? "Landstrip isolated environment";

    const network = init.options.network ?? "none";
    const mode = init.options.appContainerMode ?? "standard";
    const readScope = mode === "lpac" ? "allow-list" : "platform-default";
    const summary = renderIsolationSummary({
      workspace: this.#workspace,
      writableRoots: this.#writableRoots,
      readableRoots: this.#readableRoots,
      readScope,
      network: network === "none" ? "none" : "host-configured",
      extraNotes: [
        `Isolation implementation: AppContainer (${mode}) executed by the landstrip runtime.`,
        readScope === "allow-list"
          ? "Reads are limited to the listed roots by the restricted package access mode."
          : "Reads are decided by the isolation identity grants together with the platform rules for this AppContainer mode; paths without such a grant are denied, and directory enumeration of some ancestor directories succeeds.",
        "Commands are started as argv without a host shell.",
        "Metadata of ancestor directories above the granted roots is denied, so programs that resolve paths up to the volume root fail. Node programs receive --preserve-symlinks-main so the main module loads without resolving ancestors.",
      ],
    });
    this.#ownership = {
      providerId: this.providerId,
      environmentId: this.environmentId,
      ownsHostWorkspace: false,
      preservesHostWorkspaceOnClose: true,
      disposableResources: [`environment state directory ${this.#stateDirectory}`],
      preservedResources: [`workspace ${this.#workspace}`, "export destinations"],
      exportDestinationsHostOwned: true,
    };
    this.#description = {
      platform: "win32",
      environmentId: this.environmentId,
      providerId: this.providerId,
      displayName: this.displayName,
      workingDirectory: this.#workingDirectory,
      workspace: this.#workspace,
      capabilities: { ...FULL_ENVIRONMENT_CAPABILITIES },
      programs: [...new Set(["node", ...(init.options.requiredPrograms ?? []).map((item) => item.program)])],
      limits: this.#limits,
      isolation: {
        workspace: this.#workspace,
        writableRoots: this.#writableRoots,
        readableRoots: this.#readableRoots,
        readScope,
        writeScope: "allow-list",
        network: network === "none" ? "none" : "host-configured",
        summary,
      },
      ownership: this.#ownership,
      limitations: [
        "Metadata of ancestor directories above the granted roots cannot be inspected.",
        "Each file operation starts a separate isolated process.",
        "Writable directories must not contain hard-linked files. The host must keep granted roots and runtime files under trusted ownership while the environment is open.",
        "CPU time and memory consumption cannot be capped by this provider.",
      ],
    };
  }

  async describe(): Promise<EnvironmentDescription> {
    return this.#description;
  }

  ownership(): EnvironmentResourceOwnership {
    return this.#ownership;
  }

  async status(): Promise<EnvironmentStatus> {
    return {
      state: this.#state,
      providerId: this.providerId,
      environmentId: this.environmentId,
      startedAt: this.#startedAt,
      activeProcesses: this.#active.size,
      detail: `workspace ${this.#workspace}`,
    };
  }

  onStateChange(listener: (status: EnvironmentStatus) => void): () => void {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  async statFile(
    path: string,
    options?: EnvironmentPathOperationOptions,
  ): Promise<EnvironmentFileStat> {
    const result = await this.#fileOperation("stat", path, {}, options?.signal);
    return this.#toStat(path, result);
  }

  async readFile(
    path: string,
    options?: EnvironmentReadFileOptions,
  ): Promise<EnvironmentFileContents> {
    const maxBytes = Math.min(options?.maxBytes ?? Number.MAX_SAFE_INTEGER, this.#limits.maxFileBytes);
    requirePositiveInteger(maxBytes, "maxBytes");
    const target = this.#resolve(path);
    const information = await this.#statTarget(target, false, options?.signal);
    if (information === undefined || information.type !== "file") {
      throw new EnvironmentError(
        "ENVIRONMENT_PATH_NOT_A_FILE",
        `path is not a file: ${path}`,
      );
    }
    if (information.size > maxBytes) {
      throw new EnvironmentError(
        "ENVIRONMENT_OUTPUT_TOO_LARGE",
        `file exceeds the ${maxBytes}-byte limit: ${path}`,
      );
    }
    const result = await this.#fileOperation("read", path, { maxBytes: String(maxBytes) }, options?.signal);
    if (result.truncated || result.stdout.length > maxBytes) {
      throw new EnvironmentError(
        "ENVIRONMENT_OUTPUT_TOO_LARGE",
        `file exceeds the ${maxBytes}-byte limit: ${path}`,
      );
    }
    const bytes = result.stdout;
    const fileStat = this.#toStat(path, result);
    if (options?.encoding === "utf8") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        throw new EnvironmentError(
          "ENVIRONMENT_INVALID_UTF8",
          `file must be valid UTF-8: ${path}`,
          { cause: error },
        );
      }
      return { ...fileStat, bytes, text };
    }
    return { ...fileStat, bytes };
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: EnvironmentWriteFileOptions,
  ): Promise<EnvironmentFileStat> {
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (payload.byteLength > this.#limits.maxFileBytes) {
      throw new EnvironmentError(
        "ENVIRONMENT_OUTPUT_TOO_LARGE",
        `file exceeds the ${this.#limits.maxFileBytes}-byte limit: ${path}`,
      );
    }
    const target = this.#resolve(path);
    if (options?.overwrite === false) {
      const existing = await this.#statTarget(target, true, options?.signal);
      if (existing !== undefined) {
        throw new EnvironmentError(
          "ENVIRONMENT_PATH_EXISTS",
          `file already exists: ${path}`,
        );
      }
    }
    const result = await this.#fileOperation(
      "write",
      path,
      {
        Overwrite: options?.overwrite === false ? "false" : "true",
        CreateParents: options?.createParents === false ? "false" : "true",
      },
      options?.signal,
      payload,
    );
    return this.#toStat(path, result);
  }

  async listDirectory(
    path: string,
    options?: EnvironmentListDirectoryOptions,
  ): Promise<EnvironmentDirectoryListing> {
    requirePositiveInteger(options?.maxEntries ?? 10_000, "maxEntries");
    const result = await this.#fileOperation(
      "list",
      path,
      {
        Recursive: options?.recursive === true ? "true" : "false",
        maxEntries: String(options?.maxEntries ?? 10_000),
      },
      options?.signal,
    );
    const entries: EnvironmentDirectoryEntry[] = [];
    let truncated = result.truncated;
    const limit = options?.maxEntries ?? 10_000;
    for (const raw of result.entries) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push({
        name: String(raw.name),
        path: String(raw.path),
        type: normalizeEntryType(String(raw.type)),
        size: Number(raw.size ?? 0),
        modifiedAtSeconds: Number(raw.modifiedAtSeconds ?? 0),
        ...(raw.linkTarget === undefined || raw.linkTarget === null || raw.linkTarget === ""
          ? {}
          : { linkTarget: String(raw.linkTarget) }),
      });
    }
    return { path: this.#normalize(path), entries, truncated };
  }

  async makeDirectory(
    path: string,
    options?: EnvironmentMakeDirectoryOptions,
  ): Promise<EnvironmentFileStat> {
    const result = await this.#fileOperation(
      "mkdir",
      path,
      { Recursive: options?.recursive === true ? "true" : "false" },
      options?.signal,
    );
    return this.#toStat(path, result);
  }

  async removeFile(
    path: string,
    options?: EnvironmentPathOperationOptions,
  ): Promise<void> {
    await this.#fileOperation("remove-file", path, {}, options?.signal);
  }

  async removeDirectory(
    path: string,
    options?: EnvironmentRemoveDirectoryOptions,
  ): Promise<void> {
    await this.#fileOperation(
      "remove-directory",
      path,
      { Recursive: options?.recursive === true ? "true" : "false" },
      options?.signal,
    );
  }

  async startProcess(
    request: EnvironmentProcessRequest,
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcess> {
    this.#assertOpen();
    if (options?.signal?.aborted === true) {
      throw new EnvironmentError(
        "ENVIRONMENT_PROCESS_CANCELLED",
        `process request for ${request.command} was aborted before it started`,
      );
    }
    if (this.#active.size >= this.#limits.maxConcurrentProcesses) {
      throw new EnvironmentError(
        "ENVIRONMENT_PROCESS_LIMIT_REACHED",
        `environment ${this.environmentId} already runs ${this.#active.size} processes, limit is ${this.#limits.maxConcurrentProcesses}`,
      );
    }
    if (request.command.trim() === "") {
      throw new EnvironmentError(
        "ENVIRONMENT_INVALID_OPTION",
        "command must not be empty",
      );
    }
    requirePositiveInteger(request.timeoutMs ?? this.#limits.processTimeoutMs, "timeoutMs");
    requirePositiveInteger(options?.maxOutputBytes ?? this.#limits.maxOutputBytesPerProcess, "maxOutputBytes");
    requirePositiveInteger(options?.cancelGraceMs ?? DEFAULT_PROCESS_CANCEL_GRACE_MS, "cancelGraceMs");
    await assertWritableRootsSafe(this.#writableRoots);
    this.#assertOpen();
    options?.signal?.throwIfAborted();
    if (this.#active.size >= this.#limits.maxConcurrentProcesses) {
      throw new EnvironmentError("ENVIRONMENT_PROCESS_LIMIT_REACHED", "environment process limit reached");
    }
    const cwd = request.cwd === undefined
      ? this.#workingDirectory
      : joinPath(this.#workingDirectory, this.#normalize(request.cwd));
    const argv = [
      ...this.#runArguments(this.#agentPolicyPath),
      join(this.#runtimeDirectory, "node.exe"),
      "--preserve-symlinks-main",
      join(this.#runtimeDirectory, "launch.cjs"),
      JSON.stringify({ command: request.command, args: this.#programArguments(request.command, request.args ?? []) }),
    ];
    this.#counter += 1;
    const processId = `${this.environmentId}-p${this.#counter}`;
    const env = { ...this.#baseEnvironment, ...(request.env ?? {}) };
    const maxOutputBytes = Math.min(
      options?.maxOutputBytes ?? this.#limits.maxOutputBytesPerProcess,
      this.#limits.maxOutputBytesPerProcess,
    );
    const running = startCommand(this.#binary, argv, {
      cwd,
      env,
      ...(request.input === undefined ? {} : { input: request.input }),
      maxOutputBytes,
      captureOutput: options?.captureOutput ?? true,
    });
    const handle = new EnvironmentProcessHandle({
      processId,
      command: [request.command, ...(request.args ?? [])],
      child: running.child,
      maxOutputBytes,
      captureOutput: options?.captureOutput ?? true,
      cancelGraceMs: options?.cancelGraceMs ?? DEFAULT_PROCESS_CANCEL_GRACE_MS,
    });
    this.#active.set(processId, { handle });
    const timeoutMs = Math.min(
      request.timeoutMs ?? this.#limits.processTimeoutMs,
      this.#limits.processTimeoutMs,
    );
    const timer = setTimeout(() => {
      handle.markTimedOut();
      void handle.cancel("timeout");
    }, timeoutMs);
    const signal = options?.signal;
    const onAbort = () => {
      void handle.cancel("host abort");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    handle.result
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (handle.status().endedAt !== undefined) this.#active.delete(processId);
      });
    return handle;
  }

  async runProcess(
    request: EnvironmentProcessRequest,
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcessResult> {
    const handle = await this.startProcess(request, options);
    return handle.result;
  }

  async readArtifact(
    reference: EnvironmentArtifactReference,
    options?: EnvironmentReadArtifactOptions,
  ): Promise<EnvironmentFileContents> {
    assertArtifactReference(reference, this.environmentId);
    return this.readFile(reference.path, {
      ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      encoding: "binary",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async exportArtifact(
    reference: EnvironmentArtifactReference,
    destination: string,
    options?: EnvironmentExportArtifactOptions,
  ): Promise<EnvironmentArtifactExport> {
    this.#assertOpen();
    assertArtifactReference(reference, this.environmentId);
    if (!isAbsolute(destination)) {
      throw new EnvironmentError(
        "ENVIRONMENT_INVALID_OPTION",
        `destination must be an absolute host path: ${destination}`,
      );
    }
    const contents = await this.readArtifact(reference, {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    options?.signal?.throwIfAborted();
    const existing = await lstat(destination).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (existing !== undefined && options?.overwrite !== true) {
      throw new EnvironmentError(
        "ENVIRONMENT_EXPORT_DESTINATION_EXISTS",
        `export destination already exists: ${destination}`,
      );
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.may-export-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temporary, contents.bytes, options?.signal === undefined ? undefined : { signal: options.signal });
      options?.signal?.throwIfAborted();
      if (options?.overwrite === true) {
        await rename(temporary, destination);
      } else {
        await copyFile(temporary, destination, constants.COPYFILE_EXCL);
        await rm(temporary, { force: true });
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      reference,
      destination,
      bytes: contents.bytes.byteLength,
      exportedAt: new Date().toISOString(),
    };
  }

  async close(options?: EnvironmentCloseOptions): Promise<EnvironmentCloseReport> {
    this.#closePromise ??= this.#closeOnce(options);
    return this.#closePromise;
  }

  async #closeOnce(options?: EnvironmentCloseOptions): Promise<EnvironmentCloseReport> {
    if (this.#closeReport !== undefined) return this.#closeReport;
    this.#setState("closing");
    const unconfirmed: string[] = [];
    let stopped = 0;
    for (const [, entry] of [...this.#active]) {
      const cancellation = await entry.handle.cancel(
        options?.reason ?? "environment closed",
      );
      stopped += 1;
      if (!cancellation.confirmed) unconfirmed.push(entry.handle.processId);
    }
    if (unconfirmed.length !== 0) {
      throw new EnvironmentError("ENVIRONMENT_PROCESS_CANCEL_UNCONFIRMED", `process termination is unconfirmed: ${unconfirmed.join(", ")}`);
    }
    this.#active.clear();
    await rm(this.#stateDirectory, { recursive: true, force: true });
    const report: EnvironmentCloseReport = {
      environmentId: this.environmentId,
      providerId: this.providerId,
      closedAt: new Date().toISOString(),
      stoppedProcesses: stopped,
      unconfirmedProcessIds: unconfirmed,
      removedResources: [`state directory ${this.#stateDirectory}`],
      preservedResources: [`workspace ${this.#workspace}`, "export destinations"],
      preservedHostWorkspace: true,
    };
    this.#closeReport = report;
    this.#setState("closed");
    return report;
  }

  /** 在环境内验证必需的程序，创建环境时调用。 */
  async verifyProgram(requirement: EnvironmentProgramRequirement): Promise<void> {
    const args = requirement.args ?? ["--version"];
    const result = await this.runProcess(
      { command: requirement.program, args },
      this.#options.signal === undefined ? undefined : { signal: this.#options.signal },
    );
    const stdout = result.stdout;
    const stderr = result.stderr;
    if (result.exitCode !== 0) {
      throw new EnvironmentError(
        "ENVIRONMENT_REQUIRED_PROGRAM_MISSING",
        `required program is not available inside the environment: ${requirement.program} (${stderr.trim() || stdout.trim()})`,
      );
    }
    if (
      requirement.expectedOutput !== undefined &&
      !`${stdout}\n${stderr}`.includes(requirement.expectedOutput)
    ) {
      throw new EnvironmentError(
        "ENVIRONMENT_REQUIRED_PROGRAM_MISMATCH",
        `required program ${requirement.program} did not report ${requirement.expectedOutput}`,
      );
    }
  }

  /**
   * 创建时验证基础文件操作真实可用，任何一步失败都让创建失败。
   * 验证使用工作区内的临时文件，完成后删除。
   */
  async verifyFileOperations(): Promise<void> {
    const probeDirectory = `.may-self-check-${randomBytes(6).toString("hex")}`;
    const probePath = `${probeDirectory}/data.bin`;
    const payload = Buffer.from(
      Array.from({ length: Math.min(256, this.#limits.maxFileBytes) }, (_value, index) => index),
    );
    await this.makeDirectory(probeDirectory);
    try {
      const written = await this.writeFile(probePath, payload);
      if (written.size !== payload.byteLength) {
        throw new EnvironmentError(
          "ENVIRONMENT_INITIALIZATION_FAILED",
          `file operation write returned ${written.size} bytes instead of ${payload.byteLength}`,
        );
      }
      const read = await this.readFile(probePath, { encoding: "binary" });
      if (Buffer.compare(Buffer.from(read.bytes), payload) !== 0) {
        throw new EnvironmentError(
          "ENVIRONMENT_INITIALIZATION_FAILED",
          "file operation read did not return the written bytes",
        );
      }
      const listing = await this.listDirectory(probeDirectory);
      if (!listing.entries.some((entry) => entry.path === probePath)) {
        throw new EnvironmentError(
          "ENVIRONMENT_INITIALIZATION_FAILED",
          "file operation list did not report the probe file",
        );
      }
      const information = await this.statFile(probePath);
      if (information.type !== "file" || information.size !== payload.byteLength) {
        throw new EnvironmentError(
          "ENVIRONMENT_INITIALIZATION_FAILED",
          "file operation stat returned unexpected metadata",
        );
      }
    } finally {
      try {
        await this.removeFile(probePath);
      } catch (error) {
        if (!(error instanceof EnvironmentError) || error.code !== "ENVIRONMENT_PATH_NOT_FOUND") throw error;
      }
      await this.removeDirectory(probeDirectory);
    }
  }

  #runArguments(policyPath: string): string[] {
    return ["run", "-p", policyPath, "--"];
  }

  #resolve(path: string): string {
    return joinPath(this.#workingDirectory, this.#normalize(path));
  }

  #normalize(path: string): string {
    if (isAbsolute(path)) {
      const inside = relative(this.#workingDirectory, path);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new EnvironmentError(
          "ENVIRONMENT_INVALID_PATH",
          `absolute path must be inside the workspace: ${path}`,
        );
      }
      return resolveEnvironmentPath(this.#workingDirectory, inside === "" ? "." : inside.split(sep).join("/"), { platform: "win32" }).relative;
    }
    return resolveEnvironmentPath(this.#workingDirectory, path, { platform: "win32" }).relative;
  }

  #assertOpen(): void {
    if (this.#state === "closing" || this.#state === "closed") {
      throw new EnvironmentError(
        "ENVIRONMENT_CLOSED",
        `environment ${this.environmentId} is ${this.#state}`,
      );
    }
  }

  /**
   * 为特定程序补充必要参数。Node 程序需要避免解析祖先目录元数据，
   * 因此在调用方未指定时添加 --preserve-symlinks-main。
   */
  #programArguments(command: string, args: readonly string[]): string[] {
    const name = basename(command).toLowerCase().replace(/\.exe$/u, "");
    if (
      !this.#nodePreserveSymlinks ||
      name !== "node" ||
      args.includes("--preserve-symlinks-main")
    ) {
      return [...args];
    }
    return ["--preserve-symlinks-main", ...args];
  }

  #setState(state: EnvironmentStatus["state"]): void {
    this.#state = state;
    const status: EnvironmentStatus = {
      state,
      providerId: this.providerId,
      environmentId: this.environmentId,
      startedAt: this.#startedAt,
      activeProcesses: this.#active.size,
      detail: `workspace ${this.#workspace}`,
    };
    for (const listener of [...this.#stateListeners]) listener(status);
  }

  async #statTarget(
    target: string,
    tolerant = false,
    signal?: AbortSignal,
  ): Promise<(EnvironmentFileStat & { type: EnvironmentEntryType }) | undefined> {
    try {
      const result = await this.#fileOperation("stat", target, {}, signal);
      return this.#toStat(target, result);
    } catch (error) {
      if (tolerant && error instanceof EnvironmentError && error.code === "ENVIRONMENT_PATH_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
  }

  #toStat(path: string, result: { metadata: Record<string, unknown> }): EnvironmentFileStat {
    const metadata = result.metadata ?? {};
    return {
      path: this.#normalize(String(metadata.absolutePath ?? this.#resolve(path))),
      absolutePath: String(metadata.absolutePath ?? this.#resolve(path)),
      ...(metadata.linkCount === undefined ? {} : { linkCount: Number(metadata.linkCount) }),
      type: normalizeEntryType(String(metadata.type ?? "other")),
      size: Number(metadata.size ?? 0),
      modifiedAtSeconds: Number(metadata.modifiedAtSeconds ?? 0),
      ...(metadata.linkTarget === undefined || metadata.linkTarget === null || metadata.linkTarget === ""
        ? {}
        : { linkTarget: String(metadata.linkTarget) }),
    };
  }

  async #fileOperation(
    operation: string,
    path: string,
    extra: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    input?: Uint8Array,
  ): Promise<{
    metadata: Record<string, unknown>;
    entries: Record<string, unknown>[];
    stdout: Buffer;
    truncated: boolean;
  }> {
    this.#assertOpen();
    signal?.throwIfAborted();
    await assertWritableRootsSafe(this.#writableRoots);
    this.#assertOpen();
    if (this.#active.size >= this.#limits.maxConcurrentProcesses) {
      throw new EnvironmentError("ENVIRONMENT_PROCESS_LIMIT_REACHED", "environment process limit reached");
    }
    const target = this.#resolve(path);
    const args = [
      ...this.#runArguments(this.#fileOperationPolicyPath),
      join(this.#runtimeDirectory, "node.exe"),
      "--preserve-symlinks-main",
      this.#script,
      operation,
      this.#workingDirectory,
      target,
      JSON.stringify({ ...extra, maxBytes: Math.min(Number(extra.maxBytes ?? this.#limits.maxFileBytes), this.#limits.maxFileBytes), maxEntries: Number(extra.maxEntries ?? 10000) }),
    ];
    this.#counter += 1;
    const processId = `${this.environmentId}-f${this.#counter}`;
    signal?.throwIfAborted();
    const maxOutputBytes = this.#limits.maxFileBytes + DEFAULT_PROCESS_MAX_OUTPUT_BYTES;
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    const running = startCommand(this.#binary, args, {
      cwd: this.#workingDirectory,
      env: this.#baseEnvironment,
      ...(input === undefined ? {} : { input }),
      maxOutputBytes,
      captureOutput: false,
      onStdout: (chunk) => stdout.append(chunk),
      onStderr: (chunk) => stderr.append(chunk),
    });
    const handle = new EnvironmentProcessHandle({
      processId,
      command: [this.#binary, ...args],
      child: running.child,
      maxOutputBytes,
      captureOutput: false,
      cancelGraceMs: DEFAULT_PROCESS_CANCEL_GRACE_MS,
    });
    this.#active.set(processId, { handle });
    const timer = setTimeout(() => {
      handle.markTimedOut();
      void handle.cancel("file operation timeout");
    }, this.#limits.processTimeoutMs);
    const onAbort = () => {
      void handle.cancel("host abort");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let outcome: EnvironmentProcessResult;
    try {
      outcome = await handle.result;
    } catch (error) {
      if (isCancelled(error) && signal?.aborted === true) {
        throw new EnvironmentError(
          "ENVIRONMENT_PROCESS_CANCELLED",
          `file operation ${operation} for ${path} was cancelled`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (handle.status().endedAt !== undefined) this.#active.delete(processId);
    }
    const payload = extractOperationPayload(stderr.buffer());
    if (payload === undefined) {
      throw new EnvironmentError(
        "ENVIRONMENT_INVALID_RESULT",
        `file operation ${operation} produced no result for ${path}: ${stderr.text().trim()}`,
      );
    }
    if (payload.ok !== true || outcome.exitCode !== 0) {
      throw new EnvironmentError(
        mapOperationCode(String(payload.code ?? "ENVIRONMENT_OPERATION_FAILED")),
        String(payload.message ?? "file operation failed") +
          (payload.position === undefined ? "" : ` (${String(payload.position)})`),
      );
    }
    return {
      metadata: (payload.metadata ?? {}) as Record<string, unknown>,
      entries: Array.isArray(payload.entries) ? (payload.entries as Record<string, unknown>[]) : [],
      stdout: stdout.buffer(),
      truncated: stdout.truncated() || payload.truncated === true,
    };
  }
}

/** 创建使用 landstrip 隔离的执行环境。 */
export async function createLandstripEnvironment(
  options: LandstripEnvironmentOptions,
): Promise<EnvironmentProvider> {
  if (process.platform !== "win32") {
    throw new EnvironmentError(
      "ENVIRONMENT_UNSUPPORTED_PLATFORM",
      `the landstrip environment currently supports win32 only, received ${process.platform}`,
    );
  }
  const workspace = await requireDirectory(options.workspace, "workspace");
  options.signal?.throwIfAborted();
  const writableRoots = uniquePaths(
    await Promise.all(
      (options.writablePaths ?? [workspace]).map((value) => realpathOrFail(value)),
    ),
  );
  await assertWritableRootsSafe(writableRoots);
  // 工作区必须包含在一个可写目录内。
  if (!writableRoots.some((root) => contains(root, workspace))) {
    throw new EnvironmentError(
      "ENVIRONMENT_INVALID_OPTION",
      `the workspace ${workspace} must be inside one of the writable paths: ${writableRoots.join(", ")}`,
    );
  }
  const sourceRuntimeDirectory = await requireDirectory(
    fileURLToPath(new URL("../runtime/windows", import.meta.url)),
    "runtime directory",
  );
  const sourceScript = join(sourceRuntimeDirectory, "file-operation.cjs");
  await stat(sourceScript);
  const sourceBinary = await realpathOrFail(options.binary ?? landstripBinaryPath());
  await stat(sourceBinary);

  // 环境自建目录分两部分：private 保存隔离配置，runtime 保存启动所需文件。
  const stateDirectory = await realpathOrFail(
    await mkdtemp(join(tmpdir(), "may-environment-")),
  );
  const privateDirectory = join(stateDirectory, "private");
  const runtimeDirectory = join(stateDirectory, "runtime");
  try {
    await mkdir(privateDirectory, { recursive: true });
    await mkdir(runtimeDirectory, { recursive: true });
    // 本次使用的运行文件由宿主管理，项目修改不会影响它们。
    const script = join(runtimeDirectory, "file-operation.cjs");
    const binary = join(runtimeDirectory, "landstrip.exe");
    await copyFile(sourceScript, script);
    await copyFile(sourceBinary, binary);
    await copyFile(join(sourceRuntimeDirectory, "launch.cjs"), join(runtimeDirectory, "launch.cjs"));
    // 仅复制默认文件内容，运行文件不会携带宿主的 NTFS policy stream。
    await pipeline(createReadStream(process.execPath), createWriteStream(join(runtimeDirectory, "node.exe"), { flags: "wx" }));
    for (const root of writableRoots) {
      if (contains(root, stateDirectory)) {
        throw new EnvironmentError(
          "ENVIRONMENT_INVALID_OPTION",
          `environment-owned files must stay outside every writable path, but ${stateDirectory} is inside ${root}`,
        );
      }
    }
    return await startLandstripEnvironment({
      options,
      workspace,
      writableRoots,
      runtimeDirectory,
      privateDirectory,
      script,
      binary,
      stateDirectory,
    });
  } catch (error) {
    await rm(stateDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** 写入隔离策略、验证隔离运行时并完成环境自身的检查。 */
async function startLandstripEnvironment(input: {
  readonly options: LandstripEnvironmentOptions;
  readonly workspace: string;
  readonly writableRoots: readonly string[];
  readonly runtimeDirectory: string;
  readonly privateDirectory: string;
  readonly script: string;
  readonly binary: string;
  readonly stateDirectory: string;
}): Promise<LandstripEnvironment> {
  const {
    options,
    workspace,
    writableRoots,
    runtimeDirectory,
    privateDirectory,
    script,
    binary,
    stateDirectory,
  } = input;
  const limits = resolveLimits(options.limits);
  const values = hostSystemEnvironment();
  const stateRealPath = stateDirectory;
  const readableRoots = uniquePaths(
    await Promise.all(
      [
        workspace,
        runtimeDirectory,
        values["windir"] ?? values["SystemRoot"] ?? "",
        ...(options.readablePaths ?? []),
      ].map((value) => realpathOrFail(value)),
    ),
  );
  const deniedReadPaths = uniquePaths([
    privateDirectory,
    ...await Promise.all(
      (options.deniedReadPaths ?? []).map((value) => realpathOrFail(value)),
    ),
  ]);
  const basePolicy = {
    windows: {
      appContainerMode: options.appContainerMode ?? "standard",
      allowLoopback: false,
    },
    filesystem: {
      allowRead: readableRoots,
      allowWrite: writableRoots,
      // Windows 需要非空的拒绝读取清单才会启用受限读取模式。
      denyRead: deniedReadPaths,
      ...(options.deniedWritePaths === undefined || options.deniedWritePaths.length === 0
        ? {}
        : {
            denyWrite: await Promise.all(
              options.deniedWritePaths.map((value) => realpathOrFail(value)),
            ),
          }),
    },
    network: {
      allowNetwork: options.network === "allow",
      allowLocalBinding: false,
    },
  };
  const environmentId = `env-${randomBytes(6).toString("hex")}`;
  const privatePolicyPath = join(privateDirectory, "agent-policy.json");
  const fileOperationPolicyPath = join(privateDirectory, "file-operation-policy.json");
  // Agent 可以读取运行文件，写入权限仅属于宿主。
  const agentPolicy = {
    ...basePolicy,
    filesystem: {
      ...basePolicy.filesystem,
      denyRead: basePolicy.filesystem.denyRead,
    },
  };
  // 文件操作需要读取环境自建的运行代码，同样禁止读取配置。
  const fileOperationPolicy = {
    ...basePolicy,
    filesystem: {
      ...basePolicy.filesystem,
      allowRead: uniquePaths([...basePolicy.filesystem.allowRead, runtimeDirectory]),
    },
  };
  await writeFile(privatePolicyPath, `${JSON.stringify(agentPolicy, null, 2)}\n`, "utf8");
  await writeFile(
    fileOperationPolicyPath,
    `${JSON.stringify(fileOperationPolicy, null, 2)}\n`,
    "utf8",
  );

  const baseEnvironment = {
    ...values,
    PATH: `${runtimeDirectory};${values.PATH}`,
    ...(options.nodePreserveSymlinks === false ? {} : { NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" }),
    ...(options.environment ?? {}),
  };
  const baseOptions = {
    cwd: workspace,
    env: baseEnvironment,
    maxOutputBytes: DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
    captureOutput: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const doctor = await runCommand(binary, ["doctor"], baseOptions);
  const health = parseJsonObject(doctor.stdout.toString("utf8"));
  if (doctor.outcome.exitCode !== 0 || health?.ok !== true) {
    throw new EnvironmentError(
      "ENVIRONMENT_PROVIDER_UNAVAILABLE",
      `the isolation runtime is not usable: ${doctor.stderr.toString("utf8").trim() || doctor.stdout.toString("utf8").trim()}`,
    );
  }
  for (const policyPath of [privatePolicyPath, fileOperationPolicyPath]) {
    const validation = await runCommand(binary, ["policy", "validate", "-p", policyPath], baseOptions);
    if (validation.outcome.exitCode !== 0) {
      throw new EnvironmentError(
        "ENVIRONMENT_PROVIDER_UNAVAILABLE",
        `the isolation policy cannot be enforced: ${validation.stderr.toString("utf8").trim() || validation.stdout.toString("utf8").trim() || `exit code ${String(validation.outcome.exitCode)}`}`,
      );
    }
  }

  const environment = new LandstripEnvironment({
    options,
    binary,
    workspace,
    stateDirectory,
    agentPolicyPath: privatePolicyPath,
    fileOperationPolicyPath,
    readableRoots,
    writableRoots,
    baseEnvironment,
    runtimeDirectory,
    script,
    limits,
    environmentId,
  });

  // 初始化期间任何一步失败都立即释放环境自建资源。
  try {
    for (const requirement of options.requiredPrograms ?? []) {
      await environment.verifyProgram(requirement);
    }
    await environment.verifyFileOperations();
  } catch (error) {
    await environment.close({ reason: "environment initialization failed" });
    throw error;
  }
  return environment;
}

async function requireDirectory(value: string, label: string): Promise<string> {
  const target = await realpathOrFail(value);
  const information = await stat(target);
  if (!information.isDirectory()) {
    throw new EnvironmentError(
      "ENVIRONMENT_INVALID_OPTION",
      `${label} must be a directory: ${value}`,
    );
  }
  return target;
}

/** 使用真实路径解析结果，失败时立即报错。 */
async function realpathOrFail(value: string): Promise<string> {
  try {
    return await realpath(resolve(value));
  } catch (error) {
    throw new EnvironmentError(
      "ENVIRONMENT_INVALID_OPTION",
      `path must exist and be resolvable: ${value}`,
      { cause: error },
    );
  }
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EnvironmentError("ENVIRONMENT_INVALID_OPTION", `${name} must be a positive safe integer`);
  }
}

/** 可写目录不能包含共享文件内容，检查时不进入符号链接目录。 */
async function assertWritableRootsSafe(roots: readonly string[]): Promise<void> {
  const pending = [...roots];
  while (pending.length !== 0) {
    const target = pending.pop()!;
    const information = await lstat(target);
    if (information.isSymbolicLink()) continue;
    if (information.isFile() && information.nlink > 1) {
      throw new EnvironmentError(
        "ENVIRONMENT_PATH_UNSUPPORTED",
        `writable paths must not contain hard-linked files: ${target}`,
      );
    }
    if (information.isDirectory()) {
      for (const entry of await readdir(target, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) pending.push(join(target, entry.name));
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** 真实路径包含判断，符号链接与 junction 在 realpath 之后比较。 */
function contains(root: string, target: string): boolean {
  const normalizedRoot = root.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}\\`) ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
}

function normalizeEntryType(value: string): EnvironmentEntryType {
  if (value === "file" || value === "directory") return value;
  if (value === "symbolic link" || value === "SymbolicLink" || value === "symlink") {
    return "symlink";
  }
  return "other";
}

function mapOperationCode(value: string): EnvironmentError["code"] {
  const known: EnvironmentError["code"][] = [
    "ENVIRONMENT_INVALID_PATH",
    "ENVIRONMENT_PATH_NOT_FOUND",
    "ENVIRONMENT_PATH_NOT_A_FILE",
    "ENVIRONMENT_PATH_EXISTS",
    "ENVIRONMENT_PATH_FORBIDDEN",
    "ENVIRONMENT_INVALID_OPTION",
    "ENVIRONMENT_OUTPUT_TOO_LARGE",
    "ENVIRONMENT_PATH_UNSUPPORTED",
  ];
  return (known as string[]).includes(value)
    ? (value as EnvironmentError["code"])
    : "ENVIRONMENT_INVALID_RESULT";
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed.split("\n").pop() ?? "");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractOperationPayload(stderr: Buffer): Record<string, unknown> | undefined {
  let payload: Record<string, unknown> | undefined;
  for (const line of stderr.toString("utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
      payload = parsed as Record<string, unknown>;
    }
  }
  return payload;
}

function isCancelled(error: unknown): boolean {
  return (
    error instanceof EnvironmentError &&
    error.code === "ENVIRONMENT_PROCESS_CANCELLED"
  );
}

export type { EnvironmentCapabilities };
