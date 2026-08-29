export class ProviderRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRegistryError";
  }
}

export class ProviderConfigurationError extends ProviderRegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderConfigurationError";
  }
}
