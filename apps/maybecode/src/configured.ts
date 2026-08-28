import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadMayConfig,
  type LoadMayConfigOptions,
  type MayConfig,
} from "@may/config";
import type { ContextFactory } from "@may/context";
import type { Model } from "@may/core";
import { FileSessionStore } from "@may/session/file-store";

import { FileSessionCatalog } from "./catalog.js";
import {
  createMaybeCodeModel,
  selectMaybeCodeModel,
  type MaybeCodeModelSelector,
  type SelectedMaybeCodeModel,
} from "./model.js";
import { resolveMaybeCodeInstructionsDirectory } from "./instructions.js";
import { MaybeCodeWorkspace } from "./workspace.js";

export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  readonly workspace?: string;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly sessionId?: string;
  readonly autoResume?: boolean;
  readonly contextFactory?: ContextFactory;
  readonly instructions?: string;
  readonly maxSteps?: number;
}

export interface ConfiguredMaybeCodeDependencies {
  readonly loadConfig?: (
    options?: LoadMayConfigOptions,
  ) => Promise<MayConfig>;
  readonly createModel?: (selection: SelectedMaybeCodeModel) => Model;
}

export function getDefaultMaybeCodeDataDirectory(): string {
  return join(homedir(), ".may", "maybecode");
}

export async function openConfiguredMaybeCode(
  options: OpenConfiguredMaybeCodeOptions = {},
  dependencies: ConfiguredMaybeCodeDependencies = {},
): Promise<MaybeCodeWorkspace> {
  const workspace = await resolveWorkspace(options.workspace ?? process.cwd());
  const loadConfig = dependencies.loadConfig ?? loadMayConfig;
  const config = await loadConfig(
    options.configPath === undefined ? {} : { path: options.configPath },
  );
  const selection = selectMaybeCodeModel(config, {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const model = (dependencies.createModel ?? createMaybeCodeModel)(selection);
  const instructionsDirectory = options.instructions === undefined
    ? resolveMaybeCodeInstructionsDirectory(config)
    : undefined;
  const dataDirectory = resolve(
    options.dataDirectory ?? getDefaultMaybeCodeDataDirectory(),
  );

  return MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new FileSessionStore(join(dataDirectory, "sessions")),
    catalog: new FileSessionCatalog(join(dataDirectory, "catalog.json")),
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.autoResume === undefined
      ? {}
      : { autoResume: options.autoResume }),
    ...(options.contextFactory === undefined
      ? {}
      : { contextFactory: options.contextFactory }),
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
    ...(instructionsDirectory === undefined
      ? {}
      : { instructionsDirectory }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
}

async function resolveWorkspace(workspace: string): Promise<string> {
  if (process.platform === "win32" && /^[A-Za-z]:[^\\/]/u.test(workspace)) {
    throw new Error(
      `Workspace path "${workspace}" is drive-relative. ` +
        "Git Bash removes unquoted backslashes; use forward slashes " +
        "(for example E:/code/project) or single-quote the path.",
    );
  }
  const path = await realpath(resolve(workspace));
  const information = await stat(path);
  if (!information.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  return path;
}
