/** @experimental */
export class ProviderAdapterRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderAdapterRegistryError";
  }
}

/** @experimental */
export class ProviderConfigurationError extends ProviderAdapterRegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderConfigurationError";
  }
}

/** @experimental */
export class ServerToolStateMismatchError extends Error {
  readonly code = "SERVER_TOOL_STATE_MISMATCH";
  constructor() {
    super("Continue unfinished server tools with the same adapter, model, baseURL and server tool configuration");
    this.name = "ServerToolStateMismatchError";
  }
}
