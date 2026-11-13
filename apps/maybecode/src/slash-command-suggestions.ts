import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import type { MaybeCodeController } from "./controller.js";
import {
  MAYBECODE_COMPACTION_STRATEGIES,
  maybeCodeSlashCommands,
  reasoningEffortChoices,
  reasoningEffortDescription,
  type MaybeCodeSlashCommandSuggester,
} from "./slash-commands.js";

export function createMaybeCodeSlashCommandSuggester(
  controller: MaybeCodeController,
  options: { readonly sessionCacheMs?: number } = {},
): MaybeCodeSlashCommandSuggester {
  const sessionCacheMs = options.sessionCacheMs ?? 1_000;
  if (!Number.isFinite(sessionCacheMs) || sessionCacheMs < 0) {
    throw new RangeError("sessionCacheMs must be a non-negative finite number");
  }
  let cachedSessions: readonly SessionSummary[] | undefined;
  let cachedAt = 0;

  const sessions = async (): Promise<readonly SessionSummary[]> => {
    const now = Date.now();
    if (cachedSessions === undefined || now - cachedAt >= sessionCacheMs) {
      cachedSessions = await controller.listSessions();
      cachedAt = Date.now();
    }
    return cachedSessions;
  };

  return maybeCodeSlashCommands.createSuggester(async (argumentInput) => {
    const { definition, invokedAs: command, argumentPrefix } = argumentInput;
    if (definition?.name === "/delegations") {
      const match = /^notifications\s+(\S*)$/u.exec(argumentPrefix);
      if (match)
        return ["on", "off", "status"]
          .filter((value) => value.startsWith(match[1]!))
          .map((value) => ({ value: `${command} notifications ${value}`, label: value }));
      return ["show", "notifications", "tools", "resolve"]
        .filter((value) => value.startsWith(argumentPrefix))
        .map((value) => ({ value: `${command} ${value}`, label: value }));
    }
    if (definition?.name === "/yolo") {
      return ["on", "off", "status"]
        .filter((value) => value.startsWith(argumentPrefix))
        .map((value) => ({ value: `${command} ${value}`, label: value, description: "Permission mode" }));
    }
    if (definition?.name === "/goal") {
      return ["start", "status", "pause", "resume", "cancel"]
        .filter((verb) => verb.startsWith(argumentPrefix))
        .map((verb) => ({ value: `${command} ${verb}`, label: verb }));
    }
    if (definition?.name === "/skills") {
      const match = /^(show|use)\s+(\S*)$/u.exec(argumentPrefix);
      if (match)
        return controller.application
          .listSkills()
          .filter((skill) => skill.name.startsWith(match[2]!))
          .map((skill) => ({
            value: `${command} ${match[1]} ${skill.name}`,
            label: skill.name,
            description: skill.description,
          }));
      if (/\s/u.test(argumentPrefix)) return [];
      return ["show", "use"]
        .filter((verb) => verb.startsWith(argumentPrefix))
        .map((verb) => ({
          value: `${command} ${verb}`,
          label: verb,
          description: verb === "show" ? "Preview without activation" : "Activate for the current session",
        }));
    }
    if (definition?.name === "/compact") {
      if (/\s/u.test(argumentPrefix)) return [];
      return MAYBECODE_COMPACTION_STRATEGIES.filter((strategy) => strategy.startsWith(argumentPrefix)).map(
        (strategy) => ({
          value: `${command} ${strategy}`,
          label: strategy,
          description:
            strategy === "provider-native"
              ? "Compact with the active model's native compactor"
              : "Keep the current request and fresh saved work notes",
        }),
      );
    }

    if (definition?.name === "/resume") {
      if (/\s/u.test(argumentPrefix)) return [];
      return (await sessions())
        .filter((session) => session.id.startsWith(argumentPrefix))
        .map((session) => ({
          value: `${command} ${session.id}`,
          label: session.id,
          description:
            session.id === controller.sessionId
              ? "Current session"
              : `Last used ${new Date(session.lastUsedAt).toISOString()}`,
        }));
    }

    if (definition?.name === "/model") {
      const optionInput = /^(\S+)\s+(\S*)$/u.exec(argumentPrefix);
      if (optionInput !== null) {
        const optionPrefix = optionInput[2]!;
        return "--default".startsWith(optionPrefix)
          ? [
              {
                value: `${command} ${optionInput[1]} --default`,
                label: "--default",
                description: "Switch to this profile and make it the default",
              },
            ]
          : [];
      }
      if (/\s/u.test(argumentPrefix)) return [];
      const normalized = argumentPrefix.toLowerCase();
      return (await controller.listModels())
        .filter((model) => model.name.toLowerCase().startsWith(normalized))
        .map((model) => ({
          value: `${command} ${model.name}`,
          label: model.name,
          description:
            model.name === controller.application.modelInfo?.profile
              ? `Current · ${model.provider}/${model.model}`
              : `${model.provider}/${model.model} · ${model.adapter}`,
        }));
    }

    if (definition?.name === "/effort") {
      if (/\s/u.test(argumentPrefix)) return [];
      const state = await controller.getReasoningEffort();
      if (state.status !== "known") return [];
      const normalized = argumentPrefix.toLowerCase();
      return reasoningEffortChoices(state)
        .filter((effort) => effort.toLowerCase().startsWith(normalized))
        .map((effort) => ({
          value: `${command} ${effort}`,
          label: effort,
          description: reasoningEffortDescription(effort, state),
        }));
    }

    return [];
  });
}
