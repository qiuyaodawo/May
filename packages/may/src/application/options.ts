import type { ContextBudget, ContextCompactionStrategy, ContextFactory } from "../context/index.js";
import type { Model, Tool, ToolExecutor, ToolScheduler, Tracer, TraceAttributes, RunBudget } from "../core/index.js";
import type { AnyPlugin, PluginHostOptions } from "../plugin/index.js";
import type { PermissionCheck, PermissionPolicy, PermissionRuleStore } from "../permissions/index.js";
import type { SessionStore } from "../session/index.js";
import type { SessionHistoryToolOptions } from "../session/tools.js";
import type { SkillRegistry } from "../skills/index.js";

/** @experimental */
export interface AgentToolPresentation {
  readonly kind: string;
  readonly version: number;
  readonly data: unknown;
}

/** @experimental */
export interface AgentApplicationOptions {
  readonly requestRecording?: "off" | "required";
  readonly providerBodyRecording?: boolean | undefined;
  readonly model?: Model;
  readonly store: SessionStore;
  readonly permissionPolicy?: PermissionPolicy;
  readonly permissionRuleStore?: PermissionRuleStore;
  readonly plugins?: readonly AnyPlugin[];
  readonly pluginHookTimeoutMs?: number;
  readonly onPluginHookError?: PluginHostOptions["onHookError"];
  readonly tools?: Iterable<Tool>;
  /** Additional host catalog captured per Run; static tools remain fixed. */
  readonly toolSource?: () => Iterable<Tool>;
  /** Trusted host routing labels. The application supplies its own sessionId. */
  readonly toolScope?: Readonly<Record<string, string>>;
  readonly toolExecutor?: ToolExecutor;
  /** 权限批准之后、执行工具之前运行的宿主检查。 */
  readonly beforeToolExecute?: (execution: Parameters<ToolExecutor["execute"]>[0]) => Promise<void>;
  readonly toolScheduler?: ToolScheduler;
  readonly tracer?: Tracer;
  /** Content-free attributes attached to every Run opened by this application. */
  readonly traceAttributes?: TraceAttributes;
  readonly instructions?: string;
  readonly skills?: SkillRegistry;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly fork?: AgentApplicationFork;
  readonly forkStateKeys?: readonly string[];
  readonly forkPluginIds?: readonly string[];
  readonly forkStateTransform?: (key: string, value: unknown) => unknown;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  /** Default strategy used by explicit compaction and by the context itself. */
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  /** Include the model-native compactor in the automatic chain, when present. */
  readonly providerNativeAutoCompaction?: boolean;
  readonly maxSteps?: number;
  readonly runBudget?: RunBudget;
  readonly responseFormat?: import("../core/index.js").ModelResponseFormat;
  /** Add the bounded session_history tool with these optional limits. */
  readonly sessionHistory?:
    | false
    | (Omit<SessionHistoryToolOptions, "source"> & {
        /** Also expose bounded content search and chunked record reads. */
        readonly retrieval?: boolean;
      });
  /**
   * Produce durable, model-invisible display metadata before permission policy
   * evaluation. Coding diffs are one possible use; the application owns data.
   */
  readonly createToolPresentation?: (
    check: PermissionCheck,
  ) => AgentToolPresentation | undefined | Promise<AgentToolPresentation | undefined>;
  /** Validate metadata after a session is created or resumed. */
  readonly validateSession?: (metadata: Readonly<Record<string, unknown>> | undefined) => void | Promise<void>;
  readonly closeReason?: string;
}

/** @experimental */
export interface AgentApplicationFork {
  readonly sessionId: string;
  readonly positionSeq: number;
}
