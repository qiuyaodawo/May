import type { Model } from "@may/core";

import { ProviderAdapterRegistryError } from "./errors.js";
import type {
  ProviderAdapterFactory,
  ProviderModelSelection,
} from "./types.js";

export class ProviderAdapterRegistry {
  private readonly factories = new Map<string, ProviderAdapterFactory>();

  register(name: string, factory: ProviderAdapterFactory): this {
    validateAdapterName(name);
    if (typeof factory !== "object" || factory === null) {
      throw new TypeError("adapter factory must be an object");
    }
    if (typeof factory.create !== "function") {
      throw new TypeError("adapter factory must define create(selection)");
    }
    if (this.factories.has(name)) {
      throw new ProviderAdapterRegistryError(
        `Adapter "${name}" is already registered`,
      );
    }
    this.factories.set(name, factory);
    return this;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  names(): readonly string[] {
    return [...this.factories.keys()];
  }

  create(selection: ProviderModelSelection): Model {
    const factory = this.factories.get(selection.adapter);
    if (factory === undefined) {
      const available = this.names();
      throw new ProviderAdapterRegistryError(
        `Unsupported adapter "${selection.adapter}"` +
          (available.length === 0
            ? "; no adapters are registered"
            : `; available adapters: ${available.join(", ")}`),
      );
    }
    return factory.create(selection);
  }
}

function validateAdapterName(name: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("adapter name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new TypeError("adapter name must not have surrounding whitespace");
  }
}
