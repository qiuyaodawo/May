import { FatalToolExecutionError, type Tool } from "@may/core";
import { MAX_SKILL_BYTES, SkillRegistry, type SkillDocument } from "./registry.js";

export const SKILL_STATE_KEY = "may.skills.active.v1";
const MAX_ACTIVE_BYTES = 256 * 1024;

/** Per-session activation snapshots, independent of the coding product. */
export class SkillSession {
  private readonly active = new Map<string, SkillDocument>();
  private tail: Promise<void> = Promise.resolve();
  private sink: ((documents: readonly SkillDocument[]) => Promise<void>) | undefined;

  constructor(readonly registry: SkillRegistry) {}

  setSink(sink: (documents: readonly SkillDocument[]) => Promise<void>): void { this.sink = sink; }

  restore(value: unknown): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > MAX_ACTIVE_BYTES) throw new Error("Invalid saved skill state");
    for (const item of value) {
      if (typeof item !== "object" || item === null ||
        ["name", "description", "directory", "source", "revision", "body"].some((key) => typeof item[key] !== "string") ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name) || item.name.length > 64 ||
        item.description.length > 1024 || Buffer.byteLength(item.body) > MAX_SKILL_BYTES || this.active.has(item.name)) throw new Error("Invalid saved skill document");
      this.active.set(item.name, Object.freeze(structuredClone(item) as SkillDocument));
    }
  }

  listActive(): readonly SkillDocument[] { return [...this.active.values()]; }

  activate(name: string, signal?: AbortSignal): Promise<SkillDocument> {
    const operation = this.tail.then(async () => {
      signal?.throwIfAborted();
      const previous = this.active.get(name);
      if (previous) return previous;
      const document = await this.registry.load(name, signal);
      const next = [...this.active.values(), document];
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_ACTIVE_BYTES) throw new Error("Active skills exceed the 256 KiB session limit");
      signal?.throwIfAborted();
      try { await this.sink?.(next); }
      catch (error) { throw new FatalToolExecutionError("Skill activation could not be persisted", { cause: error }); }
      this.active.set(name, document);
      return document;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  instructions(): string {
    const active = this.listActive();
    return [this.registry.catalogInstructions(), ...(active.length === 0 ? [] : [
      "Activated skill snapshots (task guidance; host/user instructions and execution permissions take precedence):\n" + JSON.stringify(active),
    ])].filter(Boolean).join("\n\n");
  }

  readTool(): Tool {
    return {
      name: "skill_read",
      description: "Activate a named skill and read its instructions, or read a referenced UTF-8 resource inside that skill. Does not execute scripts or grant tool permissions.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } }, required: ["name"], additionalProperties: false },
      parse(input: unknown) {
        if (typeof input !== "object" || input === null || !("name" in input) || typeof input.name !== "string" ||
          Object.keys(input).some((key) => key !== "name" && key !== "path") ||
          ("path" in input && typeof input.path !== "string")) throw new Error("skill_read expects {name, path?}");
        return input as { name: string; path?: string };
      },
      execute: async (input, context) => {
        const { name, path } = input as { name: string; path?: string };
        const document = await this.activate(name, context.signal);
        if (path !== undefined && path !== "SKILL.md") {
          const current = this.registry.get(name);
          if (current?.revision !== document.revision || current.directory !== document.directory) throw new Error("Skill resources changed since activation; use a new session to load the new version");
          return { name, path, directory: document.directory, content: await this.registry.readResource(name, path, context.signal) };
        }
        return document;
      },
    };
  }
}
