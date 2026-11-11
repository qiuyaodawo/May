import { resolve } from "node:path";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { openLanguageServerManager, type LanguageServerManager } from "@sortedyuan/lsp-tools";
import type { MaybeCodeLspSettings } from "./settings.js";
import {
  openCodingExecutionEnvironment,
  type CodingExecutionEnvironment,
  type CodingExecutionIsolation,
} from "@sortedyuan/coding-tools";

export class TeamExecutionEnvironments {
  private readonly environments = new Map<string, Promise<CodingExecutionEnvironment>>();
  private readonly managers = new Map<string, Promise<LanguageServerManager>>();
  private closed = false;
  constructor(
    private readonly isolation: CodingExecutionIsolation = { mode: "host" },
    private readonly lsp?: false | MaybeCodeLspSettings,
    private readonly dataDirectory = join(homedir(), ".may", "maybecode"),
  ) {}
  get(workspace: string): Promise<CodingExecutionEnvironment> {
    if (this.closed) throw new Error("Team execution environments are closed");
    const directory = resolve(workspace);
    let environment = this.environments.get(directory);
    if (environment === undefined) {
      environment = openCodingExecutionEnvironment({
        workspace: directory,
        isolation: this.isolation,
        cacheDirectory: join(this.dataDirectory, "cache", createHash("sha256").update(directory).digest("hex")),
      });
      this.environments.set(directory, environment);
    }
    return environment;
  }
  async languageServers(workspace: string): Promise<LanguageServerManager | undefined> {
    if (this.closed) throw new Error("Team execution environments are closed");
    if (!this.lsp) return undefined;
    const directory = resolve(workspace);
    let manager = this.managers.get(directory);
    if (!manager) {
      const { servers, editDiagnostics: _editDiagnostics, ...limits } = this.lsp;
      manager = this.get(directory).then((execution) =>
        openLanguageServerManager({
          ...limits,
          execution,
          dataDirectory: this.dataDirectory,
          servers: Object.entries(servers).map(([id, server]) => ({ id, ...server })),
        }),
      );
      this.managers.set(directory, manager);
    }
    return manager;
  }
  async close(): Promise<void> {
    this.closed = true;
    const managerResults = await Promise.allSettled(
      [...this.managers.values()].map(async (manager) => (await manager).close()),
    );
    const results = await Promise.allSettled(
      [...this.environments.values()].map(async (environment) => (await environment).close()),
    );
    const failures = [...managerResults, ...results].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Unable to close team execution environments");
  }
}
