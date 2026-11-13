import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { openLanguageServerManager, type LanguageServerManager } from "@sortedyuan/lsp-tools";
import { createMaybeCodeToolPresentation } from "./tool-presentation.js";
import type { MaybeCodeLspSettings, MaybeCodeWebSearchSettings } from "./settings.js";
import type { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import { GitRequestController } from "./git-request.js";
import type { SkillRegistry } from "@sortedyuan/may/skills";

import { applicationServices, defineAgent, withDefaultCompactionThreshold } from "@sortedyuan/may";
import type { AgentApplication, AgentApplicationFork } from "@sortedyuan/may";
import {
  openCodingExecutionEnvironment,
  type CodingExecutionEnvironment,
  type CodingExecutionIsolation,
  type FetchToolOptions,
} from "@sortedyuan/coding-tools";
import type {
  ContextBudget,
  ContextCompactionStrategy,
  ContextSummarizer,
  ContextFactory,
} from "@sortedyuan/may/context";
import {
  omitUndefined,
  ToolRegistry,
  type Model,
  type Context,
  type RunBudget,
  type Tool,
  type TraceAttributes,
  type Tracer,
} from "@sortedyuan/may/core";
import type { PermissionPolicy, PermissionRuleStore } from "@sortedyuan/may/permissions";
import type { MaybeCodePermissionMode } from "./policy.js";
import type { AnyPlugin } from "@sortedyuan/may/plugin";
import type { SessionStore } from "@sortedyuan/may/session";

import type { MaybeCodeAutoCompactionMode, MaybeCodeModelInfo } from "./controller.js";
import { loadMaybeCodeInstructions, MaybeCodeInstructionState } from "./instructions.js";
import { createMaybeCodePlugins, type MaybeCodePluginComposition } from "./plugins/application.js";
import { createMaybeCodeInstructionsPlugin } from "./plugins/instructions.js";
import type {
  MaybeCodeSubagentConfiguration,
  MaybeCodeSubagentRole,
} from "@sortedyuan/coordination/delegation/configuration";
import type { MaybeCodeApplication, MaybeCodeModelUpdate } from "./application.js";

/** MaybeCode 主 Run 的默认步数上限；显式 maxSteps 覆盖该值。 */
const MAYBECODE_MAX_STEPS = 32;

/** 子 Agent 默认启用；宿主可以显式关闭或替换角色与限制。 */
export interface MaybeCodeSubagentOptions {
  /** 缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 缺省时使用 Session 存储目录下的 subagents。 */
  readonly dataDirectory?: string;
  /** 声明了自己 model profile 的角色使用的宿主模型工厂。 */
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model | undefined;
  /** 角色自有模型的上下文预算；没有配置时继承主会话。 */
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
  readonly toolSource?: () => Iterable<Tool>;
}

export interface MaybeCodeApplicationOptions {
  readonly lsp?: false | MaybeCodeLspSettings;
  readonly webSearch?: false | MaybeCodeWebSearchSettings;
  readonly searchToolsForModel?: (model: MaybeCodeModelInfo | undefined) => Promise<readonly Tool[]>;
  readonly dataDirectory?: string;
  readonly execution?: CodingExecutionIsolation;
  readonly fetch?: FetchToolOptions;
  readonly requestRecording?: "off" | "required";
  readonly providerBodyRecording?: boolean;
  readonly gitWorkspace?: ProjectGitWorkspace;
  readonly onGitCheckpoint?: (checkpoint: import("@sortedyuan/may/application/git-workspace").GitCheckpoint) => void;
  readonly plugins?: readonly AnyPlugin[];
  readonly workspace: string;
  readonly model?: Model;
  readonly modelInfo?: MaybeCodeModelInfo;
  readonly modelRuntimeOptions?: Readonly<Record<string, unknown>>;
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly fork?: AgentApplicationFork;
  readonly sessionMetadata?: Readonly<Record<string, unknown>>;
  readonly tools?: Iterable<Tool>;
  /** Tools appended to either the default coding tools or an explicit tool set. */
  readonly additionalTools?: Iterable<Tool>;
  /** Additional dynamic host catalog, snapshotted per Run. */
  readonly toolSource?: () => Iterable<Tool>;
  readonly permissionPolicy?: PermissionPolicy;
  readonly permissionRuleStore?: PermissionRuleStore;
  readonly permissionScopeId?: string;
  readonly permissionModeSource?: () => MaybeCodePermissionMode;
  readonly tracer?: Tracer;
  readonly traceAttributes?: TraceAttributes;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Defaults to prune-summary; explicit strategies override this mode. */
  readonly autoCompactionMode?: MaybeCodeAutoCompactionMode;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly instructionsDirectory?: string;
  /** 主 Run 的步数上限，缺省为 32。 */
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly skillDirectories?: readonly string[];
  readonly goals?: false;
  /** false 关闭子 Agent 委派；缺省启用并注册 worker 角色。 */
  readonly subagents?: false | MaybeCodeSubagentOptions;
}

export type CreateMaybeCodeApplication = (
  workspace: string,
  application: AgentApplication,
  instructions: MaybeCodeInstructionState,
  createModelPlugins: (update: MaybeCodeModelUpdate) => MaybeCodePluginComposition,
  execution: CodingExecutionEnvironment,
  gitRequest: GitRequestController,
  permissionScopeId: string | undefined,
  lsp?: LanguageServerManager,
  contextSource?: () => Context | undefined,
) => MaybeCodeApplication;

export async function openMaybeCodeApplication(
  options: MaybeCodeApplicationOptions,
  create: CreateMaybeCodeApplication,
): Promise<MaybeCodeApplication> {
  const storeDirectory = (options.store as { readonly directory?: string }).directory;
  const dataDirectory = options.dataDirectory ?? storeDirectory ?? join(homedir(), ".may", "maybecode");
  const workspaceKey = createHash("sha256").update(resolve(options.workspace)).digest("hex");
  const execution = await openCodingExecutionEnvironment({
    workspace: options.workspace,
    isolation: options.execution ?? { mode: "host" },
    cacheDirectory: join(dataDirectory, "cache", workspaceKey),
  });
  let opened = false;
  let lsp: LanguageServerManager | undefined;
  try {
    if (options.lsp) {
      const { servers, editDiagnostics: _editDiagnostics, ...limits } = options.lsp;
      lsp = await openLanguageServerManager({
        ...limits,
        execution,
        dataDirectory,
        servers: Object.entries(servers).map(([id, server]) => ({ id, ...server })),
      });
    }
    const product = await openWithExecution(options, create, execution, lsp);
    opened = true;
    return product;
  } finally {
    if (!opened) {
      try {
        await lsp?.close();
      } finally {
        await execution.close();
      }
    }
  }
}

async function openWithExecution(
  options: MaybeCodeApplicationOptions,
  create: CreateMaybeCodeApplication,
  execution: CodingExecutionEnvironment,
  lsp?: LanguageServerManager,
): Promise<MaybeCodeApplication> {
  const workspace = resolve(options.workspace);
  const configuredTools = ToolRegistry.compose(options.tools ?? [], options.additionalTools ?? []);
  const created =
    options.resume && options.sessionId && options.store.inspect
      ? (await options.store.inspect(options.sessionId))[0]
      : undefined;
  const sessionMetadata =
    options.sessionMetadata ?? (created?.type === "session.created" ? created.metadata : undefined);
  const fork = sessionMetadata?.workspaceFork as { sourceWorkspace?: string } | undefined;
  const forkOrigin = options.fork ?? (created?.type === "session.created" ? created.fork : undefined);
  const instructions = await loadMaybeCodeInstructions({
    workspace,
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.instructionsDirectory === undefined ? {} : { instructionsDirectory: options.instructionsDirectory }),
  });
  const instructionState = new MaybeCodeInstructionState(workspace, instructions);
  const initialModelInfo = options.plugins?.some((plugin) =>
    plugin.provides?.some(
      (service) => service.id === applicationServices.model.id && service.scope === applicationServices.model.scope,
    ),
  )
    ? undefined
    : options.modelInfo;

  let product: MaybeCodeApplication | undefined;
  let activeContext: Context | undefined;
  const gitRequest = new GitRequestController(options.gitWorkspace);
  const createPlugins = (current: MaybeCodeApplicationOptions) =>
    createMaybeCodePlugins(
      {
        ...current,
        plugins: [
          createMaybeCodeInstructionsPlugin(instructionState, {
            workspace,
            options: current,
            historicalBranch: forkOrigin !== undefined || fork !== undefined,
            ...omitUndefined({ historicalSource: forkOrigin?.sessionId }),
          }),
          ...(current.plugins ?? []),
        ],
        onGitCheckpoint: (checkpoint) => {
          options.onGitCheckpoint?.(checkpoint);
          if (!product) throw new Error("Git checkpoint completed before the MaybeCode application was ready");
          product.pushGitCheckpoint(checkpoint);
        },
      },
      {
        workspace,
        execution,
        ...omitUndefined({ lsp }),
        onContext: (context) => {
          activeContext = context;
        },
        gitRequest,
        instructions: instructions.system.content,
        instructionsSource: () => instructionState.current.system.content,
        projectInstructionsSource: () => instructionState.projectInstructions(),
        prepareInstructions: () => instructionState.refreshProject(),
        ...(current.contextBudget === undefined
          ? {}
          : { contextBudget: withDefaultCompactionThreshold(current.contextBudget)! }),
      },
    );
  const composition = createPlugins(options);
  const definition = defineAgent({
    requestRecording: options.requestRecording ?? "required",
    providerBodyRecording: options.providerBodyRecording,
    plugins: composition.plugins,
    forkStateKeys: ["maybecode.context-notes", "maybecode.model"],
    forkPluginIds: ["may.history-memory"],
    forkStateTransform: (key, value) => migrateForkSkillState(key, value, fork?.sourceWorkspace, workspace),
    tools: configuredTools,
    toolScope: { workspaceId: resolve(options.workspace) },
    beforeToolExecute: gitRequest.beforeToolExecute,
    instructions: instructions.system.content,
    ...omitUndefined({
      permissionRuleStore: options.permissionRuleStore,
      tracer: options.tracer,
      runBudget: options.runBudget,
    }),
    traceAttributes: {
      ...(options.traceAttributes ?? {}),
      "may.agent.name": "maybecode",
      ...omitUndefined({
        "may.model.profile": initialModelInfo?.profile,
        "may.model.provider": initialModelInfo?.provider,
        "may.model.adapter": initialModelInfo?.adapter,
        "may.model.name": initialModelInfo?.model,
      }),
    },
    maxSteps: options.maxSteps ?? MAYBECODE_MAX_STEPS,
    sessionHistory: { retrieval: true },
    createToolPresentation: (check) => createMaybeCodeToolPresentation(workspace, lsp, check),
    validateSession: (metadata) => assertWorkspace(metadata, workspace),
    closeReason: "MaybeCode is closing",
  });
  const application = await definition.open({
    store: options.store,
    metadata: { ...options.sessionMetadata, workspace },
    contextMetadata: { workspace },
    ...omitUndefined({ sessionId: options.sessionId, resume: options.resume, fork: options.fork }),
  });
  product = create(
    workspace,
    application,
    instructionState,
    (update) => {
      if (
        options.plugins?.some((plugin) =>
          plugin.provides?.some(
            (service) =>
              service.id === applicationServices.model.id && service.scope === applicationServices.model.scope,
          ),
        )
      ) {
        throw new Error("The configured Model plugin owns model selection");
      }
      const {
        model: _model,
        modelInfo: _modelInfo,
        modelRuntimeOptions: _modelRuntimeOptions,
        contextBudget: _contextBudget,
        ...base
      } = options;
      return createPlugins({ ...base, ...update });
    },
    execution,
    gitRequest,
    options.permissionRuleStore === undefined
      ? undefined
      : (options.permissionScopeId ?? `maybecode:${workspace}:main`),
    lsp,
    () => activeContext,
  );
  try {
    await product.recordModel(options.modelRuntimeOptions);
  } catch (error) {
    await product.close();
    throw error;
  }
  return product;
}

function assertWorkspace(metadata: Readonly<Record<string, unknown>> | undefined, workspace: string): void {
  const stored = metadata?.workspace;
  if (typeof stored === "string" && normalizePath(stored) !== normalizePath(workspace)) {
    throw new Error(`Session belongs to another workspace: ${stored}`);
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function migrateForkSkillState(
  key: string,
  value: unknown,
  sourceWorkspace: string | undefined,
  workspace: string,
): unknown {
  if (sourceWorkspace === undefined || normalizePath(sourceWorkspace) === normalizePath(workspace)) return value;
  const migrate = (documents: unknown): unknown => {
    if (!Array.isArray(documents)) return documents;
    return documents.map((document) => {
      if (typeof document !== "object" || document === null || typeof document.directory !== "string") return document;
      const path = relative(sourceWorkspace, document.directory);
      if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return document;
      return { ...document, directory: resolve(workspace, path) };
    });
  };
  if (key === "may.skills.active.v1") return migrate(value);
  if (key !== "may.plugins" || typeof value !== "object" || value === null) return value;
  const state = value as {
    application: Readonly<Record<string, { value: unknown }>>;
    session: Readonly<Record<string, { value: unknown }>>;
  };
  const migrateScope = (scope: typeof state.application) =>
    Object.fromEntries(Object.entries(scope).map(([id, record]) => [id, { ...record, value: migrate(record.value) }]));
  return { ...state, application: migrateScope(state.application), session: migrateScope(state.session) };
}
