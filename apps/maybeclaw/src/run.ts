import type { MayConfig } from "@sortedyuan/may/config";
import { GATEWAY_USAGE } from "./usage.js";

export const MAYBECLAW_USAGE = GATEWAY_USAGE;

export interface MaybeClawDependencies {
  readonly loadConfig?: (options: { path?: string }) => Promise<MayConfig>;
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
  readonly signal?: AbortSignal;
}

export async function runMaybeClaw(args: readonly string[], deps: MaybeClawDependencies = {}): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    (deps.stdout ?? process.stdout).write(MAYBECLAW_USAGE);
    return 0;
  }
  const { runGatewayCommand } = await import("./gateway-run.js");
  if (args.length === 0 || args[0]!.startsWith("--")) return runGatewayCommand(["serve", ...args], deps, { openBrowser: true });
  return runGatewayCommand(args, deps);
}
