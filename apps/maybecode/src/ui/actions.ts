import type { MaybeCodeSlashCommandSuggestion } from "../slash-commands.js";

export interface MaybeCodeUiAction {
  readonly id: string;
  readonly command: `/${string}`;
  readonly description: string;
  readonly run: () => string;
}

export type MaybeCodeUiCommandResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly status: string };

/** Instance-scoped display actions; these never enter the agent controller. */
export class MaybeCodeUiActionRegistry {
  private readonly actions = new Map<string, MaybeCodeUiAction>();
  private readonly commands = new Map<string, MaybeCodeUiAction>();

  register(action: MaybeCodeUiAction): this {
    if (action.id.trim() === "") throw new Error("UI action id cannot be empty");
    if (!/^\/[\w-]+$/u.test(action.command)) {
      throw new Error(`Invalid UI action command: ${action.command}`);
    }
    if (this.actions.has(action.id)) throw new Error(`Duplicate UI action: ${action.id}`);
    if (this.commands.has(action.command)) {
      throw new Error(`Duplicate UI command: ${action.command}`);
    }
    this.actions.set(action.id, action);
    this.commands.set(action.command, action);
    return this;
  }

  listCommands(): readonly {
    readonly command: string;
    readonly description: string;
  }[] {
    return [...this.actions.values()].map((action) => ({
      command: action.command,
      description: action.description,
    }));
  }

  execute(id: string): string | undefined {
    return this.actions.get(id)?.run();
  }

  executeCommand(input: string): MaybeCodeUiCommandResult {
    const [command = "", ...arguments_] = input.trim().split(/\s+/u);
    const action = this.commands.get(command.toLowerCase());
    if (action === undefined) return { matched: false };
    return arguments_.length === 0
      ? { matched: true, status: action.run() }
      : { matched: true, status: `Usage: ${action.command}` };
  }

  suggestions(input: string): readonly MaybeCodeSlashCommandSuggestion[] {
    if (!input.startsWith("/") || /\s/u.test(input)) return [];
    const prefix = input.toLowerCase();
    return [...this.actions.values()]
      .filter((action) => action.command.startsWith(prefix))
      .map((action) => ({
        value: action.command,
        label: action.command,
        description: action.description,
      }));
  }
}
