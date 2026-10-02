/**
 * 执行环境的公共接口。
 *
 * 环境抽象同一个工作区里的文件操作、命令执行与产物导出。本地隔离实现与
 * 远程 provider 使用同一组接口，路径处理使用 provider 声明的平台。
 */

/** 提供环境能力的 provider 标识。 */
export type EnvironmentProviderId = string;

export type EnvironmentState =
  | "starting"
  | "ready"
  | "closing"
  | "closed"
  | "unavailable";

export type EnvironmentEntryType = "file" | "directory" | "symlink" | "other";

/** 读取限制模型：严格允许清单、严格拒绝清单，或者由隔离实现决定。 */
export type EnvironmentReadScope =
  | "allow-list"
  | "deny-list"
  | "platform-default";

/** 写入限制模型：始终使用显式允许清单。 */
export type EnvironmentWriteScope = "allow-list";

/** 网络状态。 */
export type EnvironmentNetwork = "none" | "host-configured" | "allow-list";

/** 环境实际支持的操作。Agent 依据它判断可以做什么。 */
export interface EnvironmentCapabilities {
  readonly fileRead: boolean;
  readonly fileWrite: boolean;
  readonly directoryList: boolean;
  readonly directoryCreate: boolean;
  readonly directoryRemove: boolean;
  readonly processExecute: boolean;
  readonly processStream: boolean;
  readonly processCancel: boolean;
  readonly artifactRead: boolean;
  readonly artifactExport: boolean;
}

/** 隔离声明：环境能看到哪些路径，以及限制如何表达。 */
export interface EnvironmentIsolation {
  /** 工作区路径：本地隔离环境为宿主路径，远程环境为远端路径。 */
  readonly workspace: string;
  /** 环境允许写入的路径清单。 */
  readonly writableRoots: readonly string[];
  /** 环境允许读取的路径清单，不包含写入清单。 */
  readonly readableRoots: readonly string[];
  readonly readScope: EnvironmentReadScope;
  readonly writeScope: EnvironmentWriteScope;
  readonly network: EnvironmentNetwork;
  /** 面向 Agent 的隔离说明。 */
  readonly summary: string;
}

export interface EnvironmentResourceOwnership {
  readonly providerId: EnvironmentProviderId;
  readonly environmentId: string;
  /** 环境拥有宿主工作区目录。 */
  readonly ownsHostWorkspace: boolean;
  /** 关闭环境时保留宿主工作区内容。 */
  readonly preservesHostWorkspaceOnClose: boolean;
  /** 关闭环境时移除的资源描述。 */
  readonly disposableResources: readonly string[];
  /** 关闭环境时保留的资源描述。 */
  readonly preservedResources: readonly string[];
  /** 导出目的地由宿主拥有，关闭环境不会修改它们。 */
  readonly exportDestinationsHostOwned: boolean;
}

export type EnvironmentCredentialKind = "none" | "host-managed";

/** 凭据引用：只传递标识，凭据内容由宿主自己管理。 */
export interface EnvironmentCredentialReference {
  readonly kind: EnvironmentCredentialKind;
  /** kind 为 host-managed 时的引用标识。 */
  readonly id?: string;
}

export interface EnvironmentConnectionSummary {
  readonly endpoint: string;
  /** 环境内的工作目录。 */
  readonly workingDirectory: string;
  readonly credentialKind: EnvironmentCredentialKind;
}

export interface EnvironmentDescription {
  readonly platform: NodeJS.Platform;
  readonly environmentId: string;
  readonly providerId: EnvironmentProviderId;
  readonly displayName: string;
  /** 环境内工作目录（环境看到的路径）。 */
  readonly workingDirectory: string;
  /** 工作区路径：本地隔离环境为宿主路径，远程环境为远端路径。 */
  readonly workspace: string;
  readonly capabilities: EnvironmentCapabilities;
  /** 创建时已验证可运行的程序。 */
  readonly programs: readonly string[];
  readonly limits: EnvironmentResourceLimits;
  readonly isolation: EnvironmentIsolation;
  readonly ownership: EnvironmentResourceOwnership;
  /** 明确不可用的操作，Agent 依据它调整行为。 */
  readonly limitations: readonly string[];
  /** 远程环境声明接入信息；本地环境省略。 */
  readonly connection?: EnvironmentConnectionSummary;
}

export interface EnvironmentStatus {
  readonly state: EnvironmentState;
  readonly providerId: EnvironmentProviderId;
  readonly environmentId: string;
  readonly startedAt: string;
  readonly activeProcesses: number;
  /** provider 自述状态，例如隔离实现与运行单元。 */
  readonly detail: string;
}

export interface EnvironmentFileStat {
  readonly linkCount?: number;
  /** 规范化后的工作区相对路径，工作区本身为 "."。 */
  readonly path: string;
  /** 环境内绝对路径。 */
  readonly absolutePath: string;
  /** 符号链接解析后的目标类型。 */
  readonly type: EnvironmentEntryType;
  readonly size: number;
  /** 修改时间，Unix 秒。 */
  readonly modifiedAtSeconds: number;
  /** 路径经过符号链接时给出链接目标。 */
  readonly linkTarget?: string;
}

export interface EnvironmentFileContents extends EnvironmentFileStat {
  readonly bytes: Uint8Array;
  /** 仅在请求 utf8 编码时给出。 */
  readonly text?: string;
}

export interface EnvironmentDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: EnvironmentEntryType;
  readonly size: number;
  readonly modifiedAtSeconds: number;
  /** 符号链接目标；目标包含换行时省略，可用 statFile 精确读取。 */
  readonly linkTarget?: string;
}

export interface EnvironmentDirectoryListing {
  readonly path: string;
  readonly entries: readonly EnvironmentDirectoryEntry[];
  readonly truncated: boolean;
}

export interface EnvironmentReadFileOptions {
  readonly signal?: AbortSignal;
  /** "utf8" 同时返回 text；"binary" 只返回 bytes。 */
  readonly encoding?: "utf8" | "binary";
  readonly maxBytes?: number;
}

export interface EnvironmentWriteFileOptions {
  readonly signal?: AbortSignal;
  /** 目标已存在时是否允许覆盖，默认 true。 */
  readonly overwrite?: boolean;
  /** 缺少父目录时自动创建，默认 true。 */
  readonly createParents?: boolean;
}

export interface EnvironmentListDirectoryOptions {
  readonly signal?: AbortSignal;
  /** 递归列出全部后代，默认 false。 */
  readonly recursive?: boolean;
  readonly maxEntries?: number;
}

export interface EnvironmentPathOperationOptions {
  readonly signal?: AbortSignal;
}

export interface EnvironmentMakeDirectoryOptions
  extends EnvironmentPathOperationOptions {
  /** 已存在时不报错，默认 false。 */
  readonly recursive?: boolean;
}

export interface EnvironmentRemoveDirectoryOptions
  extends EnvironmentPathOperationOptions {
  /** 允许删除非空目录，默认 false。 */
  readonly recursive?: boolean;
}

export interface EnvironmentOutputChunk {
  readonly channel: "stdout" | "stderr";
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface EnvironmentProcessRequest {
  /** 可执行程序名称，不经过 shell 解释。 */
  readonly command: string;
  readonly args?: readonly string[];
  /** 工作区相对的工作目录，默认环境工作目录。 */
  readonly cwd?: string;
  /** 显式环境变量；默认只保留隔离所需的最小集合。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 命令标准输入内容。 */
  readonly input?: string | Uint8Array;
  /** 超时后取消进程并终止全部后代，默认 120000。 */
  readonly timeoutMs?: number;
}

export interface EnvironmentProcessOptions {
  readonly signal?: AbortSignal;
  /** 取消时等待后代终止的时长，默认 5000。 */
  readonly cancelGraceMs?: number;
  /** 收集输出的字节上限，默认 1048576。 */
  readonly maxOutputBytes?: number;
  /** 不收集输出，仅通过 onOutput 传递。 */
  readonly captureOutput?: boolean;
}

export interface EnvironmentProcessCancellation {
  readonly reason: string;
  readonly requestedAt: string;
  /** 等待返回后仍为 false 表示无法确认后代已经终止。 */
  readonly confirmed: boolean;
  readonly stoppedAt?: string;
}

export type EnvironmentProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "cancelled"
  | "failed";

export interface EnvironmentProcessStatusSnapshot {
  readonly processId: string;
  readonly state: EnvironmentProcessState;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly cancellation?: EnvironmentProcessCancellation;
}

export interface EnvironmentProcessResult {
  readonly processId: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 标准输出的原始字节；未开启输出采集时为空。 */
  readonly stdoutData: Uint8Array;
  /** 标准错误的原始字节；未开启输出采集时为空。 */
  readonly stderrData: Uint8Array;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface EnvironmentProcess {
  readonly processId: string;
  readonly command: readonly string[];
  readonly result: Promise<EnvironmentProcessResult>;
  status(): EnvironmentProcessStatusSnapshot;
  waitForExit(): Promise<EnvironmentProcessResult>;
  /** 等待返回后确认进程组已消失；等待本身不代表进程终止。 */
  cancel(reason?: string): Promise<EnvironmentProcessCancellation>;
  onOutput(listener: (chunk: EnvironmentOutputChunk) => void): () => void;
  onStatusChange(
    listener: (status: EnvironmentProcessStatusSnapshot) => void,
  ): () => void;
}

/** 产物引用始终包含 environmentId 与环境内相对路径。 */
export interface EnvironmentArtifactReference {
  readonly environmentId: string;
  readonly path: string;
  readonly kind: "file";
}

export interface EnvironmentReadArtifactOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

export interface EnvironmentExportArtifactOptions {
  readonly signal?: AbortSignal;
  /** 目的地已存在时是否允许覆盖，默认 false。 */
  readonly overwrite?: boolean;
}

export interface EnvironmentArtifactExport {
  readonly reference: EnvironmentArtifactReference;
  /** 宿主绝对路径，由宿主拥有。 */
  readonly destination: string;
  readonly bytes: number;
  readonly exportedAt: string;
}

export interface EnvironmentCloseReport {
  readonly environmentId: string;
  readonly providerId: EnvironmentProviderId;
  readonly closedAt: string;
  readonly stoppedProcesses: number;
  readonly unconfirmedProcessIds: readonly string[];
  readonly removedResources: readonly string[];
  readonly preservedResources: readonly string[];
  readonly preservedHostWorkspace: boolean;
}

export interface EnvironmentCloseOptions {
  readonly reason?: string;
}

/**
 * 环境访问接口。本地隔离实现、远程 provider 实现都提供同一组操作。
 */
export interface EnvironmentProvider {
  readonly providerId: EnvironmentProviderId;
  readonly displayName: string;
  readonly environmentId: string;
  describe(): Promise<EnvironmentDescription>;
  ownership(): EnvironmentResourceOwnership;
  status(): Promise<EnvironmentStatus>;
  onStateChange(listener: (status: EnvironmentStatus) => void): () => void;
  statFile(
    path: string,
    options?: EnvironmentPathOperationOptions,
  ): Promise<EnvironmentFileStat>;
  readFile(
    path: string,
    options?: EnvironmentReadFileOptions,
  ): Promise<EnvironmentFileContents>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: EnvironmentWriteFileOptions,
  ): Promise<EnvironmentFileStat>;
  listDirectory(
    path: string,
    options?: EnvironmentListDirectoryOptions,
  ): Promise<EnvironmentDirectoryListing>;
  makeDirectory(
    path: string,
    options?: EnvironmentMakeDirectoryOptions,
  ): Promise<EnvironmentFileStat>;
  removeFile(
    path: string,
    options?: EnvironmentPathOperationOptions,
  ): Promise<void>;
  removeDirectory(
    path: string,
    options?: EnvironmentRemoveDirectoryOptions,
  ): Promise<void>;
  startProcess(
    request: EnvironmentProcessRequest,
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcess>;
  runProcess(
    request: EnvironmentProcessRequest,
    options?: EnvironmentProcessOptions,
  ): Promise<EnvironmentProcessResult>;
  readArtifact(
    reference: EnvironmentArtifactReference,
    options?: EnvironmentReadArtifactOptions,
  ): Promise<EnvironmentFileContents>;
  exportArtifact(
    reference: EnvironmentArtifactReference,
    destination: string,
    options?: EnvironmentExportArtifactOptions,
  ): Promise<EnvironmentArtifactExport>;
  /** 幂等：只清理环境自身资源，保留宿主工作区与导出目的地。 */
  close(options?: EnvironmentCloseOptions): Promise<EnvironmentCloseReport>;
}

export interface EnvironmentConnection {
  readonly providerId: EnvironmentProviderId;
  readonly environmentId: string;
  /** 远程接入地址，例如 ssh 配置别名或 https endpoint。 */
  readonly endpoint: string;
  readonly credential: EnvironmentCredentialReference;
  /** 远程环境内的工作目录。 */
  readonly workingDirectory: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface EnvironmentFactoryContext {
  readonly signal?: AbortSignal;
  readonly requestedAt: string;
}

/**
 * 创建或接入远程环境的工厂。消费者实现该接口即可提供远程环境。
 */
export interface EnvironmentProviderFactory<TCreateOptions = unknown> {
  readonly providerId: EnvironmentProviderId;
  readonly displayName: string;
  readonly capabilities: EnvironmentCapabilities;
  /** 创建新的远程环境并返回访问接口。 */
  create(
    options: TCreateOptions,
    context?: EnvironmentFactoryContext,
  ): Promise<EnvironmentProvider>;
  /** 接入已经存在的远程环境。 */
  connect(
    connection: EnvironmentConnection,
    context?: EnvironmentFactoryContext,
  ): Promise<EnvironmentProvider>;
}

/** 环境创建时必须存在的程序。 */
export interface EnvironmentProgramRequirement {
  readonly program: string;
  /** 检查时使用的参数，默认 ["--version"]。 */
  readonly args?: readonly string[];
  /** 输出必须包含的文本片段。 */
  readonly expectedOutput?: string;
}

/** 资源限制，由 provider 在创建时校验并在运行时执行。 */
export interface EnvironmentResourceLimits {
  /** 同时运行的进程数上限。 */
  readonly maxConcurrentProcesses: number;
  /** 单个进程保留的输出字节上限。 */
  readonly maxOutputBytesPerProcess: number;
  /** 单个命令的最长运行时间毫秒数。 */
  readonly processTimeoutMs: number;
  /** 单个文件读取与写入的字节上限。 */
  readonly maxFileBytes: number;
}
