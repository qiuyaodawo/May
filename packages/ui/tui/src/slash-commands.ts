export interface SlashCommandDefinition<Name extends string = string> {
  readonly name: Name;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly description: string;
}

export interface SlashCommandInvocation<
  Definition extends SlashCommandDefinition = SlashCommandDefinition,
> {
  readonly type: "command";
  readonly definition: Definition;
  readonly invokedAs: string;
  readonly arguments: readonly string[];
}

export type SlashCommandParseResult<
  Definition extends SlashCommandDefinition = SlashCommandDefinition,
> =
  | SlashCommandInvocation<Definition>
  | { readonly type: "not-command" }
  | { readonly type: "unknown"; readonly command: string };

export interface SlashCommandSuggestion {
  /** Full input value represented by this suggestion. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SlashCommandArgumentContext<
  Definition extends SlashCommandDefinition = SlashCommandDefinition,
> {
  readonly input: string;
  readonly invokedAs: string;
  readonly argumentPrefix: string;
  readonly definition: Definition;
}

export type SlashCommandArgumentSuggester<
  Definition extends SlashCommandDefinition = SlashCommandDefinition,
> = (
  context: SlashCommandArgumentContext<Definition>,
) =>
  | readonly SlashCommandSuggestion[]
  | Promise<readonly SlashCommandSuggestion[]>;

export type SlashCommandSuggester = (
  input: string,
) => Promise<readonly SlashCommandSuggestion[]>;

/** Validated, case-insensitive registry for slash-command parsing and completion. */
export class SlashCommandRegistry<
  Definition extends SlashCommandDefinition = SlashCommandDefinition,
> {
  readonly definitions: readonly Definition[];

  private readonly byName = new Map<string, Definition>();
  private readonly names: Array<{ readonly value: string; readonly definition: Definition }> = [];

  constructor(definitions: readonly Definition[]) {
    this.definitions = [...definitions];
    for (const definition of definitions) {
      this.registerName(definition.name, definition);
      for (const alias of definition.aliases ?? []) {
        this.registerName(alias, definition);
      }
    }
  }

  find(name: string): Definition | undefined {
    return this.byName.get(name.toLowerCase());
  }

  parse(input: string): SlashCommandParseResult<Definition> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return { type: "not-command" };
    const [invokedAs = "", ...arguments_] = trimmed.split(/\s+/u);
    const definition = this.find(invokedAs);
    return definition === undefined
      ? { type: "unknown", command: invokedAs }
      : {
          type: "command",
          definition,
          invokedAs,
          arguments: arguments_,
        };
  }

  match(prefix: string): readonly SlashCommandSuggestion[] {
    if (!prefix.startsWith("/") || /\s/u.test(prefix)) return [];
    const normalized = prefix.toLowerCase();
    return this.names
      .filter(({ value }) => value.toLowerCase().startsWith(normalized))
      .map(({ value, definition }) => ({
        value,
        label: value,
        description: definition.description,
      }));
  }

  createSuggester(
    suggestArguments?: SlashCommandArgumentSuggester<Definition>,
  ): SlashCommandSuggester {
    return async (input) => {
      if (!input.startsWith("/")) return [];
      const argumentInput = splitSlashCommandArgumentInput(input);
      if (argumentInput === undefined) return this.match(input);
      const definition = this.find(argumentInput.invokedAs);
      if (definition === undefined || suggestArguments === undefined) return [];
      return suggestArguments({
        input,
        definition,
        ...argumentInput,
      });
    };
  }

  private registerName(value: string, definition: Definition): void {
    if (!isCommandName(value)) {
      throw new TypeError(`Invalid slash command name: ${JSON.stringify(value)}`);
    }
    const normalized = value.toLowerCase();
    if (this.byName.has(normalized)) {
      throw new Error(`Duplicate slash command name: ${value}`);
    }
    this.byName.set(normalized, definition);
    this.names.push({ value, definition });
  }
}

export function splitSlashCommandArgumentInput(input: string): {
  readonly invokedAs: string;
  readonly argumentPrefix: string;
} | undefined {
  const match = /^(\/\S+)\s+(.*)$/u.exec(input);
  return match === null
    ? undefined
    : { invokedAs: match[1]!, argumentPrefix: match[2]! };
}

function isCommandName(value: string): boolean {
  return /^\/\S+$/u.test(value);
}
