import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadMayConfig,
  type LoadMayConfigOptions,
  type MayConfig,
} from "@may/config";
import type {
  ContextBudget,
  ContextCompactionStrategy,
  ContextFactory,
  ContextSummarizer,
} from "@may/context";
import type { Model } from "@may/core";
import {
  withModelRetry,
  type RetryingModelOptions,
} from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";

import { FileSessionCatalog } from "./catalog.js";
import { MaybeCodeConfigError } from "./errors.js";
import {
  createMaybeCodeModel,
  selectMaybeCodeModel,
  type MaybeCodeModelSelector,
  type SelectedMaybeCodeModel,
} from "./model.js";
import {
  MAYBECODE_APPLICATION_ID,
  resolveMaybeCodeInstructionsDirectory,
} from "./instructions.js";
import { MaybeCodeWorkspace } from "./workspace.js";

export interface OpenConfiguredMaybeCodeOptions extends MaybeCodeModelSelector {
  readonly workspace?: string;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly sessionId?: string;
  readonly autoResume?: boolean;
  readonly contextFactory?: ContextFactory;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
  readonly providerNativeAutoCompaction?: boolean;
  readonly contextSummarizer?: ContextSummarizer;
  readonly instructions?: string;
  readonly maxSteps?: number;
  /** Disable retries with false, or override the configured retry policy. */
  readonly retry?: false | RetryingModelOptions;
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
  const baseModel = (dependencies.createModel ?? createMaybeCodeModel)(selection);
  const retry = options.retry ?? resolveMaybeCodeRetry(config);
  const model = retry === false ? baseModel : withModelRetry(baseModel, retry);
  const contextBudget = options.contextBudget ?? createContextBudget(
    model,
    selection,
  );
  const instructionsDirectory = options.instructions === undefined
    ? resolveMaybeCodeInstructionsDirectory(config)
    : undefined;
  const providerNativeAutoCompaction =
    options.providerNativeAutoCompaction ??
      resolveProviderNativeAutoCompaction(config);
  const dataDirectory = resolve(
    options.dataDirectory ?? getDefaultMaybeCodeDataDirectory(),
  );

  return MaybeCodeWorkspace.open({
    workspace,
    model,
    modelInfo: { provider: selection.provider, model: selection.model },
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
    ...(contextBudget === undefined ? {} : { contextBudget }),
    ...(options.compactionStrategy === undefined
      ? {}
      : { compactionStrategy: options.compactionStrategy }),
    ...(options.autoCompactionStrategies === undefined
      ? {}
      : { autoCompactionStrategies: options.autoCompactionStrategies }),
    providerNativeAutoCompaction,
    ...(options.contextSummarizer === undefined
      ? {}
      : { contextSummarizer: options.contextSummarizer }),
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
    ...(instructionsDirectory === undefined
      ? {}
      : { instructionsDirectory }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
}

export function resolveProviderNativeAutoCompaction(
  config: MayConfig,
): boolean {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.autoCompaction;
  if (value === undefined) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction must be an object",
    );
  }
  const providerNative = (value as Record<string, unknown>).providerNative;
  if (providerNative === undefined) return false;
  if (typeof providerNative !== "boolean") {
    throw new MaybeCodeConfigError(
      "apps.maybecode.autoCompaction.providerNative must be a boolean",
    );
  }
  return providerNative;
}

export function resolveMaybeCodeRetry(
  config: MayConfig,
): false | RetryingModelOptions {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.retry;
  if (value === undefined) return {};
  if (value === false) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.retry must be false or an object",
    );
  }

  const retry = value as Record<string, unknown>;
  const maxAttempts = optionalPositiveInteger(
    retry.maxAttempts,
    "apps.maybecode.retry.maxAttempts",
  );
  const baseDelayMs = optionalNonNegativeNumber(
    retry.baseDelayMs,
    "apps.maybecode.retry.baseDelayMs",
  );
  const maxDelayMs = optionalNonNegativeNumber(
    retry.maxDelayMs,
    "apps.maybecode.retry.maxDelayMs",
  );
  const jitterRatio = optionalRatio(
    retry.jitterRatio,
    "apps.maybecode.retry.jitterRatio",
  );
  if ((baseDelayMs ?? 500) > (maxDelayMs ?? 8_000)) {
    throw new MaybeCodeConfigError(
      "apps.maybecode.retry.baseDelayMs cannot exceed maxDelayMs",
    );
  }
  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
    ...(jitterRatio === undefined ? {} : { jitterRatio }),
  };
}

function createContextBudget(
  model: Model,
  selection: SelectedMaybeCodeModel,
): ContextBudget | undefined {
  const contextWindowTokens = model.limits?.contextWindowTokens ??
    selection.limits?.contextWindowTokens;
  const outputReserveTokens = model.limits?.maxOutputTokens ??
    selection.limits?.maxOutputTokens;
  if (contextWindowTokens === undefined && outputReserveTokens === undefined) {
    return undefined;
  }
  return {
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(outputReserveTokens === undefined ? {} : { outputReserveTokens }),
  };
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

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MaybeCodeConfigError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function optionalNonNegativeNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MaybeCodeConfigError(`${field} must be a non-negative number`);
  }
  return value;
}

function optionalRatio(value: unknown, field: string): number | undefined {
  const number = optionalNonNegativeNumber(value, field);
  if (number !== undefined && number > 1) {
    throw new MaybeCodeConfigError(`${field} must be between 0 and 1`);
  }
  return number;
}
