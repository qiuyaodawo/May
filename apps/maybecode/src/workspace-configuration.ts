import { isAbsolute, relative, resolve } from "node:path";
import { AgentWorkspace } from "@sortedyuan/may";
import { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import { MaybeCodeApplication, type MaybeCodeApplicationOptions } from "./application.js";
import type { MaybeCodeCompactionSelection } from "./controller.js";
import type { MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import { parsePermissionMode } from "./policy.js";
import {
  assertHistoricalModel,
  configuredModelOptions,
  readHistoricalModel,
  withModelConfiguration,
} from "./model-transition.js";
import type { MaybeCodeWorkspaceOptions } from "./workspace.js";
import type {
  ActiveWorkspaceOptions,
  BaseWorkspace,
  MaybeCodeProductEvent,
  WorkspaceState,
} from "./workspace-state.js";

export async function openWorkspaceConfiguration(
  options: MaybeCodeWorkspaceOptions,
): Promise<{ readonly state: WorkspaceState; readonly manager: BaseWorkspace }> {
  if (options.delegationNotifications !== undefined && typeof options.delegationNotifications !== "boolean") {
    throw new TypeError("delegationNotifications must be boolean");
  }
  const state: WorkspaceState = {
    rootWorkspace: resolve(options.workspace),
    git: new Map(),
    createdSessions: new Map(),
    options: withoutSelection({
      ...options,
      permissionMode: parsePermissionMode(options.permissionMode ?? "default"),
      workspace: resolve(options.workspace),
    }),
  };
  if (state.options.git !== false)
    state.git.set(
      state.rootWorkspace,
      await ProjectGitWorkspace.open({
        ...state.options.git,
        workspace: state.rootWorkspace,
        deferInitialization: true,
        excludedPaths: [
          ...(state.options.git?.excludedPaths ?? []),
          ...workspaceStoragePaths(state.options, state.rootWorkspace),
        ],
      }),
    );
  const manager = await AgentWorkspace.open<
    MaybeCodeSessionEvent,
    MaybeCodeProductEvent,
    MaybeCodeCompactionSelection,
    MaybeCodeRun,
    MaybeCodeApplication
  >({
    workspace: state.options.workspace,
    store: state.options.store,
    catalog: state.options.catalog,
    workspacePaths: async () => [
      state.rootWorkspace,
      ...((await state.git.get(state.rootWorkspace)?.listWorktrees()) ?? [])
        .filter((tree) => tree.status !== "deleted")
        .map((tree) => tree.workspace),
    ],
    openApplication: async (selection) => {
      const workspace = selection.workspace ?? state.options.workspace;
      if (
        workspace !== state.options.workspace &&
        (state.options.tools || state.options.additionalTools || state.options.toolSource) &&
        !state.options.configureWorkspace
      ) {
        throw new Error("Custom workspace tools require configureWorkspace before creating or opening a worktree");
      }
      const configured = await state.options.configureWorkspace?.(workspace);
      let gitWorkspace = state.git.get(workspace);
      if (state.options.git !== false && !gitWorkspace) {
        gitWorkspace = await ProjectGitWorkspace.open({
          ...state.options.git,
          workspace,
          deferInitialization: true,
          excludedPaths: [
            ...(state.options.git?.excludedPaths ?? []),
            ...workspaceStoragePaths(state.options, workspace),
          ],
        });
        state.git.set(workspace, gitWorkspace);
      }
      let nextOptions: ActiveWorkspaceOptions = {
        ...state.options,
        ...configured,
        workspace,
        modelRuntimeOptions:
          state.options.modelRuntimeOptions ?? configuredModelOptions(state.options, state.options.modelInfo?.profile),
      };
      if (selection.fork) {
        if (!state.options.store.inspect)
          throw new Error("Historical model selection requires read-only Session inspection");
        const history = await state.options.store.inspect(selection.fork.sessionId);
        const event = [...history]
          .reverse()
          .find(
            (item) =>
              item.seq <= selection.fork!.positionSeq &&
              item.type === "state.updated" &&
              item.key === "maybecode.model",
          );
        if (event?.type === "state.updated") {
          const saved = readHistoricalModel(event.value);
          if (saved.profile && nextOptions.createModelConfiguration) {
            const configuration = await nextOptions.createModelConfiguration(saved.profile, saved.runtimeOptions);
            assertHistoricalModel(saved, configuration.modelInfo);
            nextOptions = withModelConfiguration(nextOptions, configuration, saved.runtimeOptions);
          } else {
            assertHistoricalModel(saved, nextOptions.modelInfo);
            nextOptions = { ...nextOptions, modelRuntimeOptions: saved.runtimeOptions };
          }
        }
      }
      const app = await MaybeCodeApplication.open({
        ...applicationOptions(nextOptions, state),
        ...(gitWorkspace ? { gitWorkspace } : {}),
        ...(selection.fork ? { fork: selection.fork } : {}),
        ...(selection.metadata ? { sessionMetadata: selection.metadata } : {}),
        ...(selection.sessionId ? { sessionId: selection.sessionId } : {}),
        resume: selection.resume,
      });
      state.options = nextOptions;
      if (!selection.resume && !selection.fork) state.createdSessions.set(app.sessionId, workspace);
      return app;
    },
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.autoResume === undefined ? {} : { autoResume: options.autoResume }),
  });
  return { state, manager };
}

function withoutSelection(options: MaybeCodeWorkspaceOptions): ActiveWorkspaceOptions {
  const { sessionId: _sessionId, autoResume: _autoResume, ...base } = options;
  return base;
}

function workspaceStoragePaths(options: ActiveWorkspaceOptions, workspace: string): string[] {
  const store = options.store as { readonly directory?: unknown };
  const catalog = options.catalog as { readonly path?: unknown };
  return [
    store.directory,
    catalog.path,
    resolve(workspace, ".may", "permission-rules.json"),
    resolve(workspace, ".may", "permission-rules.json.lock"),
  ].filter((value): value is string => {
    if (typeof value !== "string") return false;
    const path = relative(workspace, resolve(value));
    return (
      path !== "" &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path)
    );
  });
}

function applicationOptions(options: ActiveWorkspaceOptions, state: WorkspaceState): MaybeCodeApplicationOptions {
  const {
    permissionMode: _permissionMode,
    delegationNotifications: _delegationNotifications,
    catalog: _catalog,
    modelProfiles: _modelProfiles,
    createModelConfiguration: _createModelConfiguration,
    resolveModelCapabilities: _resolveModelCapabilities,
    persistDefaultModel: _persistDefaultModel,
    closeOwnedResources: _closeOwnedResources,
    mcp: _mcp,
    git: _git,
    configureWorkspace: _configureWorkspace,
    ...application
  } = options;
  return { ...application, permissionModeSource: () => state.options.permissionMode ?? "default" };
}
