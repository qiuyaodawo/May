import { parseArgs } from "node:util";

export const CLI_USAGE = `May Agent evaluation

Usage:
  eval validate --suite <trusted-module.mjs>
  eval run --suite <trusted-module.mjs> --output <directory>
  eval resume --suite <trusted-module.mjs> --experiment <directory>
  eval report --experiment <directory> [--output <directory>]
  eval compare --baseline <directory> --candidate <directory> [--thresholds <JSON>]
    [--baseline-variant <id>] [--candidate-variant <id>]
  eval grade --experiment <directory> --trial <id> --evaluator <id> --result <JSON>
    [--suite <trusted-module.mjs>]

Options:
  --help                Display usage

Suite modules execute with host permissions. Results and evidence stay in the
selected experiment directory. Resume starts only planned, unstarted trials.
`;

export interface CliCommand {
  readonly command: "validate" | "run" | "resume" | "report" | "compare" | "grade";
  readonly options: Readonly<Record<string, string>>;
}

const commandOptions: Readonly<Record<CliCommand["command"], {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}>> = {
  validate: { required: ["suite"] },
  run: { required: ["suite", "output"] },
  resume: { required: ["suite", "experiment"] },
  report: { required: ["experiment"], optional: ["output"] },
  compare: { required: ["baseline", "candidate"], optional: ["thresholds", "baseline-variant", "candidate-variant"] },
  grade: { required: ["experiment", "trial", "evaluator", "result"], optional: ["suite"] },
};

export function parseCliArgs(args: readonly string[]): CliCommand | undefined {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) return undefined;
  const command = args[0];
  if (command === undefined || !Object.hasOwn(commandOptions, command)) {
    throw new TypeError(`Unknown evaluation command: ${command}`);
  }
  const definition = commandOptions[command as CliCommand["command"]];
  const allowed = [...definition.required, ...(definition.optional ?? [])];
  const parsed = parseArgs({
    args: args.slice(1),
    options: Object.fromEntries(allowed.map(key => [key, { type: "string" as const }])),
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new TypeError(`--${token.name} may only be specified once`);
    seen.add(token.name);
  }
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`--${name} requires a value`);
    options[name] = value;
  }
  for (const name of definition.required) {
    if (options[name] === undefined) throw new TypeError(`--${name} is required`);
  }
  return { command: command as CliCommand["command"], options };
}
