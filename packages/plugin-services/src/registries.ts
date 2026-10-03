import { ToolRegistry, type Model, type Tool } from "@may/core";
import type { ContextFactory } from "@may/context";
import type { Disposer } from "@may/plugin";

export interface ContributionOptions {
  readonly id: string;
  readonly order?: number;
  readonly pluginOrder?: number;
}

interface Entry<T> {
  readonly value: T;
  readonly options: ContributionOptions;
  readonly sequence: number;
}

class Contributions<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private sequence = 0;

  add(value: T, options: ContributionOptions): Disposer {
    if (typeof value !== "function") throw new TypeError("Contribution must be a function");
    if (typeof options.id !== "string" || options.id.trim() === "") throw new TypeError("Contribution id is required");
    if (![options.order ?? 0, options.pluginOrder ?? 0].every(Number.isFinite)) throw new TypeError("Contribution order must be finite");
    if (this.entries.has(options.id)) throw new Error(`Duplicate contribution id: ${options.id}`);
    const entry = { value, options: Object.freeze({ ...options }), sequence: this.sequence++ };
    this.entries.set(options.id, entry);
    return () => { if (this.entries.get(options.id) === entry) this.entries.delete(options.id); };
  }

  protected values(): readonly T[] {
    return [...this.entries.values()].sort((left, right) =>
      (left.options.order ?? 0) - (right.options.order ?? 0) ||
      (left.options.pluginOrder ?? 0) - (right.options.pluginOrder ?? 0) ||
      left.sequence - right.sequence).map((entry) => entry.value);
  }
}

export type ToolSource = () => Iterable<Tool>;
export class ToolSources extends Contributions<ToolSource> {
  snapshot(): ToolRegistry {
    const catalog = new ToolRegistry();
    for (const source of this.values()) catalog.registerAll(source());
    return catalog.snapshot();
  }
}

export type InstructionSource = () => string;
export class InstructionSources extends Contributions<InstructionSource> {
  snapshot(): string {
    return this.values().map((source) => {
      const instructions = source();
      if (typeof instructions !== "string") throw new TypeError("Instruction source must return a string");
      return instructions;
    }).filter(Boolean).join("\n\n");
  }
}

export type ModelWrapper = (model: Model) => Model;
export class ModelWrappers extends Contributions<ModelWrapper> {
  apply(model: Model): Model {
    for (const wrapper of this.values()) {
      model = wrapper(model);
      if (typeof model?.stream !== "function") throw new TypeError("Model wrapper must return a Model");
    }
    return model;
  }
}

export type ContextWrapper = (factory: ContextFactory) => ContextFactory;
export class ContextWrappers extends Contributions<ContextWrapper> {
  apply(factory: ContextFactory): ContextFactory {
    for (const wrapper of this.values()) {
      factory = wrapper(factory);
      if (typeof factory?.create !== "function") throw new TypeError("Context wrapper must return a ContextFactory");
    }
    return factory;
  }
}
