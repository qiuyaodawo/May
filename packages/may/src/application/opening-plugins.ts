import { AsyncStateSerializer, omitUndefined, RUNTIME_HOOKS } from "../core/index.js";
import type { ContextController } from "../context/index.js";
import { PluginHost, type AnyPlugin } from "../plugin/index.js";
import type { Session } from "../session/index.js";
import type { AgentApplicationOptions } from "./application.js";
import { createApplicationAccess } from "./plugin-access.js";
import { composeApplicationPlugins } from "./plugin-composition.js";
import { APPLICATION_HOOKS, applicationHooks } from "./hooks.js";
import { inspectForkHistory, filterForkPluginState } from "./session-navigation.js";
import {
  applicationServices,
  PLUGIN_STATE_KEY,
  readApplicationPluginState,
  type ApplicationPluginState,
  type PluginUpdateOptions,
} from "./plugins.js";

export async function openApplicationPlugins(
  options: AgentApplicationOptions,
  sessionId: string,
  resolveApplication: Parameters<typeof createApplicationAccess>[0],
  historySource: () => Session | undefined,
  contextController: () => ContextController | undefined,
) {
  const forkPluginIds = [
    "may.skills",
    ...(options.forkPluginIds ?? []),
    ...(options.plugins ?? [])
      .filter((plugin) =>
        plugin.provides?.some(
          (service) =>
            service.id === applicationServices.skills.id && service.scope === applicationServices.skills.scope,
        ),
      )
      .map((plugin) => plugin.id),
  ];
  const transformForkState = (key: string, value: unknown): unknown => {
    const selected =
      key === PLUGIN_STATE_KEY ? filterForkPluginState(readApplicationPluginState(value), forkPluginIds) : value;
    return options.forkStateTransform === undefined ? selected : options.forkStateTransform(key, selected);
  };
  let pluginState = readApplicationPluginState(undefined);
  if (options.resume === true || options.fork !== undefined) {
    const history =
      options.fork === undefined
        ? await options.store.read(sessionId)
        : await inspectForkHistory(options.store, options.fork);
    const event = [...history]
      .reverse()
      .find((event) => event.type === "state.updated" && event.key === PLUGIN_STATE_KEY);
    if (event?.type === "state.updated") pluginState = readApplicationPluginState(event.value);
    if (options.fork !== undefined)
      pluginState = readApplicationPluginState(transformForkState(PLUGIN_STATE_KEY, pluginState));
  }
  let pendingPluginState = false;
  const pluginStateWrites = new AsyncStateSerializer();
  const persistPluginState = (scope: "application" | "session", snapshot: ApplicationPluginState["application"]) =>
    pluginStateWrites.run(async () => {
      const candidate = { ...pluginState, [scope]: snapshot };
      const source = historySource();
      if (source === undefined) pendingPluginState = true;
      else await source.recordState(PLUGIN_STATE_KEY, candidate);
      if (scope === "application") {
        const owner = configuredPlugins.find((plugin) =>
          plugin.provides?.some(
            (service) =>
              service.id === applicationServices.skills.id && service.scope === applicationServices.skills.scope,
          ),
        );
        if (
          owner !== undefined &&
          JSON.stringify(pluginState.application[owner.id]?.value) !== JSON.stringify(snapshot[owner.id]?.value)
        ) {
          contextController()?.invalidateMeasurement?.();
        }
      }
      pluginState = candidate;
    });
  const access = createApplicationAccess(resolveApplication);
  const composePlugins = (plugins: readonly AnyPlugin[]) =>
    composeApplicationPlugins(plugins, options, access, () => options.instructions ?? "");
  let configuredPlugins = composePlugins(options.plugins ?? []);
  const pluginHost = await PluginHost.create(
    omitUndefined({
      plugins: configuredPlugins,
      hooks: [...RUNTIME_HOOKS, ...APPLICATION_HOOKS],
      timeoutMs: options.pluginHookTimeoutMs,
      onHookError: options.onPluginHookError,
    }),
  );
  let applicationScope: Awaited<ReturnType<PluginHost["createScope"]>>;
  let sessionScope: Awaited<ReturnType<PluginHost["createScope"]>>;
  try {
    applicationScope = await pluginHost.createScope("application", {
      id: sessionId,
      state: pluginState.application,
      onStateChange: (snapshot) => persistPluginState("application", snapshot),
    });
    sessionScope = await applicationScope.createScope("session", {
      id: sessionId,
      state: pluginState.session,
      onStateChange: (snapshot) => persistPluginState("session", snapshot),
    });
    const opening = await sessionScope.transform(
      applicationHooks.beforeCreate,
      omitUndefined({
        sessionId,
        resume: options.resume === true,
        metadata: options.metadata,
        contextMetadata: options.contextMetadata,
        instructions: options.instructions,
      }),
      { signal: new AbortController().signal, sessionId },
    );
    if (opening.sessionId !== sessionId || opening.resume !== (options.resume === true))
      throw new Error("Application identity cannot be modified by a Hook");
    options = { ...options, ...opening };
    sessionScope.get(applicationServices.model);
    sessionScope.get(applicationServices.permissionPolicy);
  } catch (error) {
    try {
      await pluginHost.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Application plugin initialization and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  return {
    options,
    pluginHost,
    applicationScope,
    sessionScope,
    transformForkState,
    configuredPlugins: () => configuredPlugins,
    reconfigurePlugins: async (plugins: readonly AnyPlugin[], changeOptions: PluginUpdateOptions) => {
      const next = composePlugins(plugins);
      await applicationScope.replacePlugins(next, changeOptions);
      configuredPlugins = next;
    },
    validatePlugins: (plugins: readonly AnyPlugin[]) => applicationScope.validatePlugins(composePlugins(plugins)),
    persistInitialState: async (session: Session) => {
      if (
        pendingPluginState ||
        Object.keys(applicationScope.snapshotState()).length > 0 ||
        Object.keys(sessionScope.snapshotState()).length > 0
      ) {
        await session.recordState(PLUGIN_STATE_KEY, {
          version: 1,
          application: applicationScope.snapshotState(),
          session: sessionScope.snapshotState(),
        });
      }
    },
  };
}
