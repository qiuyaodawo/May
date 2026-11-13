import type { LoadMayConfigOptions, MayConfig } from "@sortedyuan/may/config";
import type {
  ContextBudget,
  ContextCompactionStrategy,
  ContextFactory,
  ContextSummarizer,
} from "@sortedyuan/may/context";
import type { Model, RunBudget } from "@sortedyuan/may/core";
import type { McpClientPool, OpenMcpClientPoolOptions } from "@sortedyuan/mcp";
import type { ModelCapabilityResolver, ProviderAdapterRegistry, RetryingModelOptions } from "@sortedyuan/providers";
import type { MaybeCodeMcpOptions, MaybeCodeObservabilityOptions } from "./configured-resolvers.js";
import type { MaybeCodeModelSelector, SelectedMaybeCodeModel } from "./model.js";
import type { MaybeCodeAutoCompactionMode } from "./controller.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import type { ProjectGitWorkspaceOptions } from "@sortedyuan/may/application/git-workspace";
import type { SkillRegistry } from "@sortedyuan/may/skills";
import type { AnyPlugin } from "@sortedyuan/may/plugin";
import type { MaybeCodePermissionMode } from "./policy.js";
import type {
  MaybeCodeSubagentConfiguration,
  MaybeCodeSubagentRole,
} from "@sortedyuan/coordination/delegation/configuration";

/** @experimental */
export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  readonly git?: false | Omit<ProjectGitWorkspaceOptions, "workspace">;
  readonly plugins?: readonly AnyPlugin[];
  readonly permissionMode?: MaybeCodePermissionMode;
  readonly delegationNotifications?: boolean;
  readonly persistentRules?: boolean;
  /** Enable only when a UI consumes interaction events and answers the controller. */
  readonly mcpInteractions?: boolean;
  readonly workspace?: string;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly sessionId?: string;
  /** Resume the latest workspace session when no sessionId is given. Defaults to false. */
  readonly autoResume?: boolean;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  readonly autoCompactionMode?: MaybeCodeAutoCompactionMode;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly skills?: SkillRegistry | false;
  readonly goals?: false;
  readonly skillDirectories?: readonly string[];
  /** Disable retries with false, or override the configured retry policy. */
  readonly retry?: false | RetryingModelOptions;
  /** Disable tracing or override apps.maybecode.observability. */
  readonly observability?: false | MaybeCodeObservabilityOptions;
  /** Disable MCP or override apps.maybecode.mcpServers. */
  readonly mcp?: false | MaybeCodeMcpOptions;
  /** 关闭子 Agent 委派，或覆盖 apps.maybecode.subagents。 */
  readonly subagents?: false | MaybeCodeSubagentConfigurationOptions;
}

/** @experimental */
export interface MaybeCodeSubagentConfigurationOptions {
  /** 角色、限制与额度；缺省时注册 worker 角色。 */
  readonly configuration?: MaybeCodeSubagentConfiguration;
  /** 每次请求的协调记录根目录。 */
  readonly dataDirectory?: string;
  /** 声明了自己 profile 的角色使用的模型配置工厂。 */
  readonly createModel?: (role: MaybeCodeSubagentRole) => MaybeCodeModelConfiguration;
}

/** @experimental */
export interface ConfiguredMaybeCodeDependencies {
  readonly loadConfig?: (options?: LoadMayConfigOptions) => Promise<MayConfig>;
  readonly createModel?: (selection: SelectedMaybeCodeModel) => Model;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly capabilityResolver?: ModelCapabilityResolver;
  readonly persistDefaultModel?: (profile: string) => Promise<void>;
  readonly openMcp?: (options: OpenMcpClientPoolOptions) => Promise<McpClientPool>;
}
