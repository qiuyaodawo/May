import { ToolRegistry, omitUndefined, resolveRunBudget, type Tool } from "../core/index.js";
import type { SessionStore } from "../session/index.js";

import { AgentApplication, type AgentApplicationOptions } from "./application.js";

type SessionBoundAgentOption = "store" | "sessionId" | "resume" | "fork" | "metadata" | "contextMetadata";

/**
 * Reusable behavior and policy for an Agent, independent of any Session.
 *
 * Tool registries are accepted through their iterable contract. The iterable
 * is consumed and snapshotted when the definition is created.
 * @experimental
 */
export type AgentDefinitionOptions = Omit<AgentApplicationOptions, SessionBoundAgentOption | "tools"> & {
  readonly tools?: Iterable<Tool>;
};

/** Infrastructure and identity that belong to one opened Agent Session.
 * @experimental
 */
export interface AgentDefinitionOpenOptions {
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly fork?: import("./application.js").AgentApplicationFork;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
}

type StoredAgentDefinitionOptions = Omit<AgentApplicationOptions, SessionBoundAgentOption>;

/**
 * A reusable Agent composition that can open any number of independent
 * application lifecycles.
 *
 * The definition owns behavior (model, instructions, tools and policies),
 * while `open()` receives Session storage, identity and metadata. Stateful
 * collaborators such as a Model or ContextFactory remain caller-owned and are
 * intentionally shared when the same definition opens multiple applications.
 * @public
 */
export class AgentDefinition {
  private readonly applicationOptions: StoredAgentDefinitionOptions;

  constructor(options: AgentDefinitionOptions) {
    assertDefinitionOptions(options);
    this.applicationOptions = snapshotDefinitionOptions(options);
  }

  /** @public */
  open(options: AgentDefinitionOpenOptions): Promise<AgentApplication> {
    return AgentApplication.open({
      ...this.applicationOptions,
      store: options.store,
      ...omitUndefined({ sessionId: options.sessionId, resume: options.resume, fork: options.fork }),
      ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
      ...(options.contextMetadata === undefined ? {} : { contextMetadata: { ...options.contextMetadata } }),
    });
  }
}

/** Define reusable Agent behavior separately from Session lifecycle inputs.
 * @public
 */
export function defineAgent(options: AgentDefinitionOptions): AgentDefinition {
  return new AgentDefinition(options);
}

function snapshotDefinitionOptions(options: AgentDefinitionOptions): StoredAgentDefinitionOptions {
  const {
    tools,
    traceAttributes,
    contextBudget,
    runBudget,
    autoCompactionStrategies,
    sessionHistory,
    plugins,
    ...rest
  } = options;

  return Object.freeze({
    ...rest,
    ...(plugins === undefined ? {} : { plugins: Object.freeze([...plugins]) }),
    ...(runBudget === undefined ? {} : { runBudget: resolveRunBudget(runBudget) }),
    ...(tools === undefined ? {} : { tools: new ToolRegistry(tools) }),
    ...(traceAttributes === undefined ? {} : { traceAttributes: Object.freeze({ ...traceAttributes }) }),
    ...(contextBudget === undefined ? {} : { contextBudget: Object.freeze({ ...contextBudget }) }),
    ...(autoCompactionStrategies === undefined
      ? {}
      : {
          autoCompactionStrategies: Object.freeze([...autoCompactionStrategies]),
        }),
    ...(sessionHistory === undefined || sessionHistory === false
      ? sessionHistory === false
        ? { sessionHistory: false as const }
        : {}
      : { sessionHistory: Object.freeze({ ...sessionHistory }) }),
  });
}

function assertDefinitionOptions(options: AgentDefinitionOptions): void {
  const candidate = options as AgentDefinitionOptions & Partial<Record<SessionBoundAgentOption, unknown>>;
  for (const name of ["store", "sessionId", "resume", "fork", "metadata", "contextMetadata"] as const) {
    if (name in candidate) {
      throw new TypeError(`Agent definition option "${name}" is Session-bound; pass it to open()`);
    }
  }
}
