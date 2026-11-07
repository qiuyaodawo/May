import { withModelRequestRecording } from "../core/request-recording.js";
import {
  ModelContextCompactionStrategy,
  type ContextController,
  type ContextCompactionStrategy,
} from "../context/index.js";
import {
  HookExecutionError,
  omitUndefined,
  RUNTIME_HOOKS,
  type HookContext,
  type HookDispatcher,
  type Message,
  type MayOptions,
  type Tracer,
  type ToolRegistry,
  type AgentRuntime,
} from "../core/index.js";
import type { PluginHost, AnyPlugin } from "../plugin/index.js";
import type { PermissionToolExecutor } from "../permissions/index.js";
import type { Session, SessionRuntimeInfo } from "../session/index.js";
import type { ContextOptions } from "../services/index.js";
import { SKILL_STATE_KEY } from "../skills/index.js";
import type { AgentApplicationOptions } from "./application.js";
import { applicationHooks } from "./hooks.js";
import { applicationServices } from "./plugins.js";

export function assembleRuntime(
  options: AgentApplicationOptions,
  sessionId: string,
  sessionScope: Awaited<ReturnType<PluginHost["createScope"]>>,
  hooks: HookDispatcher,
  configuredTools: ToolRegistry,
  permissions: PermissionToolExecutor,
  tracer: Tracer,
  validateToolCatalog: () => void,
  historySource: () => Session | undefined,
  configuredPlugins: () => readonly AnyPlugin[],
  setContextController: (controller: ContextController | undefined) => void,
  trackRuntime: (runtime: AgentRuntime | undefined) => void,
) {
  let contextOptions: ContextOptions = {};
  const createRuntime = async (messages: Message[] = [], runtimeInfo: SessionRuntimeInfo = {}) => {
    const configuredModel = sessionScope
      .get(applicationServices.modelWrappers)
      .apply(sessionScope.get(applicationServices.model));
    const model =
      options.requestRecording !== "off"
        ? withModelRequestRecording(configuredModel, (event) => {
            const source = historySource();
            if (source === undefined) throw new Error("Session is not ready for request recording");
            return source.recordModelRequest(event);
          })
        : configuredModel;
    const contextFactory = sessionScope
      .get(applicationServices.contextWrappers)
      .apply(sessionScope.get(applicationServices.contextFactory));
    const configuredContext = sessionScope.provides(applicationServices.contextOptions)
      ? sessionScope.get(applicationServices.contextOptions)
      : {};
    contextOptions = typeof configuredContext === "function" ? configuredContext(model) : configuredContext;
    if (typeof contextOptions !== "object" || contextOptions === null)
      throw new TypeError("Context options source must return an object");
    const nativeCompactionStrategy =
      contextOptions.providerNativeAutoCompaction === true && model.contextCompactor !== undefined
        ? new ModelContextCompactionStrategy(model.contextCompactor)
        : undefined;
    const autoCompactionStrategies =
      contextOptions.autoCompactionStrategies ??
      (nativeCompactionStrategy === undefined ? [] : [nativeCompactionStrategy]);
    const hookStrategy = (strategy: ContextCompactionStrategy): ContextCompactionStrategy => ({
      name: strategy.name,
      async compact(snapshot, compactionOptions = {}) {
        const context: HookContext = omitUndefined({
          signal: compactionOptions.signal ?? new AbortController().signal,
          sessionId,
          runId: compactionOptions.runId,
          step: compactionOptions.step,
        });
        let selected;
        try {
          selected = await hooks.transform(
            applicationHooks.compactionBefore,
            { strategy: strategy.name, automatic: true },
            context,
          );
        } catch (error) {
          throw new HookExecutionError(error, applicationHooks.compactionBefore.name);
        }
        const target = [
          strategy,
          ...autoCompactionStrategies,
          ...(contextOptions.compactionStrategy === undefined ? [] : [contextOptions.compactionStrategy]),
        ].find((candidate) => candidate.name === selected.strategy);
        if (target === undefined || selected.automatic !== true)
          throw new HookExecutionError(
            new Error(`Unsupported compaction selection: ${selected.strategy}`),
            applicationHooks.compactionBefore.name,
          );
        return target.compact(snapshot, compactionOptions);
      },
    });
    const skills = sessionScope.provides(applicationServices.skills)
      ? sessionScope.get(applicationServices.skills)
      : undefined;
    if (skills !== undefined && skills.listActive().length === 0) skills.restore(runtimeInfo.state?.[SKILL_STATE_KEY]);
    let measuredInstructions: string | undefined;
    let instructionController: ContextController | undefined;
    const instructionsSource = () => {
      const current = sessionScope.get(applicationServices.instructionSources).snapshot();
      if (measuredInstructions !== undefined && current !== measuredInstructions) {
        instructionController?.invalidateMeasurement?.();
      }
      measuredInstructions = current;
      return current;
    };
    const contextMetadata = options.contextMetadata ?? options.metadata;
    const skillsInUse = skills !== undefined && (skills.registry.list().length > 0 || skills.listActive().length > 0);
    const managedContext = await contextFactory.create(
      omitUndefined({
        instructions: instructionsSource(),
        instructionsSource,
        messages,
        metadata: contextMetadata,
        budget: contextOptions.budget,
        measurement: skillsInUse ? undefined : runtimeInfo.latestModelMeasurement,
        compactionStrategy: contextOptions.compactionStrategy,
        autoCompactionStrategies: autoCompactionStrategies.map(hookStrategy),
      }),
    );
    setContextController(managedContext.controller);
    instructionController = managedContext.controller;
    const modelInfo = sessionScope.provides(applicationServices.modelInfo)
      ? sessionScope.get(applicationServices.modelInfo)
      : undefined;
    const runtimeTraceAttributes: Record<string, import("../core/index.js").TraceAttributeValue> = {
      ...(options.traceAttributes ?? {}),
      "may.session.id": sessionId,
    };
    for (const key of ["may.model.provider", "may.model.name", "may.model.adapter", "may.model.profile"])
      delete runtimeTraceAttributes[key];
    if (modelInfo !== undefined) {
      Object.assign(
        runtimeTraceAttributes,
        omitUndefined({
          "may.model.provider": modelInfo.provider,
          "may.model.name": modelInfo.model,
          "may.model.adapter": modelInfo.adapter,
          "may.model.profile": modelInfo.profile,
        }),
      );
    }
    const runtimeOptions: MayOptions = {
      model,
      tools: configuredTools,
      toolScope: () => ({ ...options.toolScope, sessionId }),
      toolSource: () => [
        ...sessionScope.get(applicationServices.toolSources).snapshot(),
        ...(sessionScope.provides(applicationServices.tools) ? sessionScope.get(applicationServices.tools) : []),
      ],
      context: managedContext.context,
      hooks,
      toolExecutor: permissions,
      tracer,
      ...omitUndefined({
        responseFormat: options.responseFormat,
        traceAttributes: Object.keys(runtimeTraceAttributes).length === 0 ? undefined : runtimeTraceAttributes,
        toolScheduler: sessionScope.provides(applicationServices.toolScheduler)
          ? sessionScope.get(applicationServices.toolScheduler)
          : undefined,
        maxSteps: options.maxSteps,
        runBudget: options.runBudget,
      }),
    };
    validateToolCatalog();
    const runtime = await sessionScope.get(applicationServices.runtimeFactory)(runtimeOptions);
    trackRuntime(runtime);
    const supportedHooks = new Set(runtime.supportedHooks?.map((hook) => hook.name) ?? []);
    for (const plugin of configuredPlugins()) {
      for (const required of plugin.requiresHooks ?? []) {
        if (RUNTIME_HOOKS.some((hook) => hook.name === required.name) && !supportedHooks.has(required.name)) {
          await runtime.close?.();
          trackRuntime(undefined);
          throw new Error(`Runtime does not support Hook "${required.name}" required by "${plugin.id}"`);
        }
      }
    }
    return runtime;
  };
  return { createRuntime, readCompactionStrategy: () => contextOptions.compactionStrategy };
}
