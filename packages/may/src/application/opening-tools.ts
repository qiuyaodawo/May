import { ToolRegistry, directToolExecutor, omitUndefined, type Tracer } from "../core/index.js";
import { PermissionToolExecutor, type PermissionCheck } from "../permissions/index.js";
import type { PluginHost } from "../plugin/index.js";
import type { Session } from "../session/index.js";
import { createSessionHistoryTool, createSessionHistoryRetrievalTools } from "../session/tools.js";
import type { AgentApplicationOptions, AgentToolPresentation } from "./application.js";
import { applicationServices } from "./plugins.js";
import type { AgentApplicationEvent } from "./events.js";

export async function recordToolPresentation(
  session: Session,
  check: PermissionCheck,
  value: AgentToolPresentation,
  emit: (event: AgentApplicationEvent) => void,
): Promise<void> {
  const presentation = {
    runId: check.context.runId,
    step: check.context.step,
    toolCallId: check.context.toolCallId,
    kind: value.kind,
    version: value.version,
    data: value.data,
  };
  await session.recordToolPresentation(presentation);
  emit({ type: "tool.presentation", presentation });
}

export function assembleOpeningTools(
  options: AgentApplicationOptions,
  sessionScope: Awaited<ReturnType<PluginHost["createScope"]>>,
  historySource: () => Session | undefined,
  recordPresentation: (check: PermissionCheck, presentation: AgentToolPresentation) => Promise<void>,
) {
  const configuredTools = new ToolRegistry();
  if (options.sessionHistory !== false && options.sessionHistory !== undefined) {
    const historyTool = createSessionHistoryTool({
      ...options.sessionHistory,
      source: () => {
        const source = historySource();
        if (source === undefined) {
          throw new Error("Session history is unavailable before session creation");
        }
        return source;
      },
    });
    if (configuredTools.has(historyTool.name)) {
      throw new Error(`Tool name "${historyTool.name}" is reserved by AgentApplication`);
    }
    configuredTools.register(historyTool);
    for (const tool of options.sessionHistory.retrieval === true
      ? createSessionHistoryRetrievalTools({ source: () => historySource()! })
      : []) {
      if (configuredTools.has(tool.name)) throw new Error(`Tool name "${tool.name}" is reserved by AgentApplication`);
      configuredTools.register(tool);
    }
  }
  const validateToolCatalog = () => {
    ToolRegistry.compose(
      configuredTools,
      sessionScope.get(applicationServices.toolSources).snapshot(),
      sessionScope.provides(applicationServices.tools) ? sessionScope.get(applicationServices.tools) : [],
    );
  };
  const tracer: Tracer = {
    startSpan: (name, traceOptions) => sessionScope.get(applicationServices.tracer).startSpan(name, traceOptions),
    recordMetric: (record) => {
      if (sessionScope.provides(applicationServices.tracer))
        sessionScope.get(applicationServices.tracer).recordMetric?.(record);
    },
  };
  const permissions = new PermissionToolExecutor({
    ...omitUndefined({ ruleStore: options.permissionRuleStore }),
    beforeCheck: async (check) => {
      const presentation = await options.createToolPresentation?.(check);
      if (presentation !== undefined) await recordPresentation(check, presentation);
    },
    policy: (check) => sessionScope.get(applicationServices.permissionPolicy)(check),
    executor: {
      execute: async (execution) => {
        await options.beforeToolExecute?.(execution);
        execution.context.signal.throwIfAborted();
        return (
          sessionScope.provides(applicationServices.toolExecutor)
            ? sessionScope.get(applicationServices.toolExecutor)
            : directToolExecutor
        ).execute(execution);
      },
    },
    tracer,
  });
  return { configuredTools, validateToolCatalog, tracer, permissions };
}
