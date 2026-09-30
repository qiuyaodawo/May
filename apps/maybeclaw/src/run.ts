import type { ModelDependencies } from "./configured.js";
import { GATEWAY_USAGE } from "./usage.js";

export const MAYBECLAW_USAGE = GATEWAY_USAGE;

export interface MaybeClawDependencies extends ModelDependencies {
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
  readonly signal?: AbortSignal;
}

export async function runMaybeClaw(args: readonly string[], deps: MaybeClawDependencies = {}): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    (deps.stdout ?? process.stdout).write(MAYBECLAW_USAGE);
    return 0;
  }
  const { runMaybeClaw: runCommand } = await import("./run-command.js");
  return runCommand(args, deps);
}
