import { MayError, ToolNotFoundError } from "./errors.js";
import type { ToolDefinition } from "./model.js";
import type { Tool } from "./tool.js";

/** Raised when composition would make tool lookup ambiguous. */
export class DuplicateToolNameError extends MayError {
  readonly toolName: string;

  constructor(toolName: string) {
    super("DUPLICATE_TOOL_NAME", `Duplicate tool name: ${toolName}`);
    this.toolName = toolName;
  }
}

interface RegisteredTool {
  readonly tool: Tool;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Tool["inputSchema"];
  readonly parse: Tool["parse"];
  readonly execute: Tool["execute"];
  readonly permissionVersion: Tool["permissionVersion"];
}

/**
 * An instance-scoped collection of tools with deterministic, duplicate-safe
 * composition. A registry never mutates another registry passed to it.
 */
export class ToolRegistry implements Iterable<Tool> {
  private readonly byName = new Map<string, RegisteredTool>();

  constructor(tools: Iterable<Tool> = []) {
    this.registerAll(tools);
  }

  get size(): number {
    return this.byName.size;
  }

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    return this.registerAll([tool as Tool]);
  }

  /**
   * Register a group as one operation. The registry remains unchanged if any
   * tool is invalid or duplicates an existing or incoming name.
   */
  registerAll(tools: Iterable<Tool>): this {
    const additions = [...tools].map(createRegistration);
    const incomingNames = new Set<string>();

    for (const registration of additions) {
      if (
        this.byName.has(registration.name) ||
        incomingNames.has(registration.name)
      ) {
        throw new DuplicateToolNameError(registration.name);
      }
      incomingNames.add(registration.name);
    }

    for (const registration of additions) {
      this.byName.set(registration.name, registration);
    }
    return this;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): Tool | undefined {
    const registration = this.byName.get(name);
    if (registration === undefined) return undefined;
    assertRegistrationUnchanged(registration);
    return registration.tool;
  }

  require(name: string): Tool {
    const tool = this.get(name);
    if (tool === undefined) throw new ToolNotFoundError(name);
    return tool;
  }

  names(): readonly string[] {
    return [...this.byName.keys()];
  }

  /** Return an insertion-ordered snapshot rather than the mutable backing map. */
  values(): readonly Tool[] {
    return [...this.byName.values()].map((registration) => {
      assertRegistrationUnchanged(registration);
      return registration.tool;
    });
  }

  /** Create model-facing definitions without exposing executable callbacks. */
  definitions(): readonly ToolDefinition[] {
    return [...this.byName.values()].map((registration) => {
      assertRegistrationUnchanged(registration);
      return {
        name: registration.name,
        description: registration.description,
        inputSchema: structuredClone(registration.inputSchema),
      };
    });
  }

  /** Capture definitions and callbacks for one Run, independent of later catalog edits. */
  snapshot(): ToolRegistry {
    return new ToolRegistry(this.values().map((tool) => {
      const execute = tool.execute;
      const parse = tool.parse;
      return Object.freeze({
        ...tool,
        name: tool.name,
        description: tool.description,
        ...(tool.permissionVersion === undefined ? {} : { permissionVersion: tool.permissionVersion }),
        inputSchema: freezeTree(structuredClone(tool.inputSchema)),
        ...(parse === undefined ? {} : { parse: (input: unknown) => parse.call(tool, input) }),
        execute: (input: unknown, context: Parameters<Tool["execute"]>[1]) =>
          execute.call(tool, input, context),
      });
    }));
  }

  clone(): ToolRegistry {
    return new ToolRegistry(this);
  }

  [Symbol.iterator](): Iterator<Tool> {
    return this.values()[Symbol.iterator]();
  }

  static compose(...sources: readonly Iterable<Tool>[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const source of sources) registry.registerAll(source);
    return registry;
  }
}

function validateTool(tool: Tool): void {
  if (typeof tool !== "object" || tool === null) {
    throw new TypeError("tool must be an object");
  }
  if (typeof tool.name !== "string" || tool.name.trim() === "") {
    throw new TypeError("tool name must be a non-empty string");
  }
  if (tool.name !== tool.name.trim()) {
    throw new TypeError("tool name must not have surrounding whitespace");
  }
  if (typeof tool.description !== "string") {
    throw new TypeError("tool description must be a string");
  }
  if (
    typeof tool.inputSchema !== "object" ||
    tool.inputSchema === null ||
    Array.isArray(tool.inputSchema)
  ) {
    throw new TypeError("tool inputSchema must be an object");
  }
  if (tool.permissionVersion !== undefined && typeof tool.permissionVersion !== "string") {
    throw new TypeError("tool permissionVersion must be a string when provided");
  }
  if (typeof tool.execute !== "function") {
    throw new TypeError("tool must define execute(input, context)");
  }
  if (tool.parse !== undefined && typeof tool.parse !== "function") {
    throw new TypeError("tool parse must be a function when provided");
  }
}

function createRegistration(tool: Tool): RegisteredTool {
  validateTool(tool);
  return {
    tool,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    parse: tool.parse,
    execute: tool.execute,
    permissionVersion: tool.permissionVersion,
  };
}

function assertRegistrationUnchanged(registration: RegisteredTool): void {
  const { tool } = registration;
  if (
    tool.name !== registration.name ||
    tool.description !== registration.description ||
    tool.inputSchema !== registration.inputSchema ||
    tool.parse !== registration.parse ||
    tool.execute !== registration.execute ||
    tool.permissionVersion !== registration.permissionVersion
  ) {
    throw new TypeError(
      `Tool "${registration.name}" changed after it was registered`,
    );
  }
}

function freezeTree<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}
