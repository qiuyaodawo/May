import { resolve } from "node:path";
import {
  openCodingExecutionEnvironment,
  type CodingExecutionEnvironment,
  type CodingExecutionIsolation,
} from "@sortedyuan/coding-tools";

export class TeamExecutionEnvironments {
  private readonly environments = new Map<string, Promise<CodingExecutionEnvironment>>();
  private closed = false;
  constructor(private readonly isolation: CodingExecutionIsolation = { mode: "host" }) {}
  get(workspace: string): Promise<CodingExecutionEnvironment> {
    if (this.closed) throw new Error("Team execution environments are closed");
    const directory = resolve(workspace);
    let environment = this.environments.get(directory);
    if (environment === undefined) {
      environment = openCodingExecutionEnvironment({ workspace: directory, isolation: this.isolation });
      this.environments.set(directory, environment);
    }
    return environment;
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.environments.values()].map(async (environment) => (await environment).close()),
    );
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Unable to close team execution environments");
  }
}
