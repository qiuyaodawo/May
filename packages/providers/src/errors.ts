export class ProviderAdapterRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderAdapterRegistryError";
  }
}

export class ProviderConfigurationError extends ProviderAdapterRegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderConfigurationError";
  }
}
