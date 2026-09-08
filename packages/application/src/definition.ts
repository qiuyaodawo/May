import { ToolRegistry, resolveRunBudget, type Tool } from "@may/core";
import type { SessionStore } from "@may/session";

import {
  AgentApplication,
  type AgentApplicationOptions,
} from "./application.js";

type SessionBoundAgentOption =
  | "store"
  | "sessionId"
  | "resume"
  | "metadata"
  | "contextMetadata";

/**
 * Reusable behavior and policy for an Agent, independent of any Session.
 *
 * Tool registries are accepted through their iterable contract. The iterable
 * is consumed and snapshotted when the definition is created.
 */
export type AgentDefinitionOptions = Omit<
  AgentApplicationOptions,
  SessionBoundAgentOption | "tools"
> & {
  readonly tools?: Iterable<Tool>;
};

/** Infrastructure and identity that belong to one opened Agent Session. */
export interface AgentDefinitionOpenOptions {
  readonly store: SessionStore;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contextMetadata?: Readonly<Record<string, unknown>>;
}

type StoredAgentDefinitionOptions = Omit<
  AgentApplicationOptions,
  SessionBoundAgentOption
>;

/**
 * A reusable Agent composition that can open any number of independent
 * application lifecycles.
 *
 * The definition owns behavior (model, instructions, tools and policies),
 * while `open()` receives Session storage, identity and metadata. Stateful
 * collaborators such as a Model or ContextFactory remain caller-owned and are
 * intentionally shared when the same definition opens multiple applications.
 */
export class AgentDefinition {
  private readonly applicationOptions: StoredAgentDefinitionOptions;

  constructor(options: AgentDefinitionOptions) {
    assertDefinitionOptions(options);
    this.applicationOptions = snapshotDefinitionOptions(options);
  }

  open(options: AgentDefinitionOpenOptions): Promise<AgentApplication> {
    assertOpenOptions(options);
    return AgentApplication.open({
      ...this.applicationOptions,
      store: options.store,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.metadata === undefined
        ? {}
        : { metadata: { ...options.metadata } }),
      ...(options.contextMetadata === undefined
        ? {}
        : { contextMetadata: { ...options.contextMetadata } }),
    });
  }
}

/** Define reusable Agent behavior separately from Session lifecycle inputs. */
export function defineAgent(options: AgentDefinitionOptions): AgentDefinition {
  return new AgentDefinition(options);
}

function snapshotDefinitionOptions(
  options: AgentDefinitionOptions,
): StoredAgentDefinitionOptions {
  const {
    tools,
    traceAttributes,
    contextBudget,
    runBudget,
    autoCompactionStrategies,
    sessionHistory,
    ...rest
  } = options;

  return Object.freeze({
    ...rest,
    ...(runBudget === undefined ? {} : { runBudget: resolveRunBudget(runBudget) }),
    ...(tools === undefined
      ? {}
      : { tools: new ToolRegistry(tools) }),
    ...(traceAttributes === undefined
      ? {}
      : { traceAttributes: Object.freeze({ ...traceAttributes }) }),
    ...(contextBudget === undefined
      ? {}
      : { contextBudget: Object.freeze({ ...contextBudget }) }),
    ...(autoCompactionStrategies === undefined
      ? {}
      : {
          autoCompactionStrategies: Object.freeze([
            ...autoCompactionStrategies,
          ]),
        }),
    ...(sessionHistory === undefined || sessionHistory === false
      ? (sessionHistory === false ? { sessionHistory: false as const } : {})
      : { sessionHistory: Object.freeze({ ...sessionHistory }) }),
  });
}

function assertDefinitionOptions(
  options: AgentDefinitionOptions,
): asserts options is AgentDefinitionOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Agent definition options must be an object");
  }

  const candidate = options as AgentDefinitionOptions &
    Partial<Record<SessionBoundAgentOption, unknown>>;
  for (
    const name of [
      "store",
      "sessionId",
      "resume",
      "metadata",
      "contextMetadata",
    ] as const
  ) {
    if (name in candidate) {
      throw new TypeError(
        `Agent definition option "${name}" is Session-bound; pass it to open()`,
      );
    }
  }
}

function assertOpenOptions(
  options: AgentDefinitionOpenOptions,
): asserts options is AgentDefinitionOpenOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Agent definition open options must be an object");
  }
  if (!("store" in options) || options.store === undefined) {
    throw new TypeError("store is required when opening an Agent definition");
  }
}
