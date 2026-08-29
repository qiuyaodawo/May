import type { Model } from "@may/core";

import { ProviderRegistryError } from "./errors.js";
import type { ProviderFactory, ProviderModelSelection } from "./types.js";

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(name: string, factory: ProviderFactory): this {
    validateProviderName(name);
    if (typeof factory !== "object" || factory === null) {
      throw new TypeError("provider factory must be an object");
    }
    if (typeof factory.create !== "function") {
      throw new TypeError("provider factory must define create(selection)");
    }
    if (this.factories.has(name)) {
      throw new ProviderRegistryError(`Provider "${name}" is already registered`);
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
    const factory = this.factories.get(selection.provider);
    if (factory === undefined) {
      const available = this.names();
      throw new ProviderRegistryError(
        `Unsupported provider "${selection.provider}"` +
          (available.length === 0
            ? "; no providers are registered"
            : `; available providers: ${available.join(", ")}`),
      );
    }
    return factory.create(selection);
  }
}

function validateProviderName(name: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("provider name must be a non-empty string");
  }
  if (name !== name.trim()) {
    throw new TypeError("provider name must not have surrounding whitespace");
  }
}
