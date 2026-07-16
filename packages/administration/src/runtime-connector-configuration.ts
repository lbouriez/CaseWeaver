import type {
  ConfigurationDescriptorReference,
  ConnectorCapability,
} from "./descriptor.js";

/**
 * Server-private request for a connector configuration used by a background
 * runtime. This is intentionally not an administration read model or HTTP DTO.
 */
export interface RuntimeConnectorConfigurationRequest {
  readonly workspaceId: string;
  readonly connectorRegistrationId: string;
  /**
   * A durable command may pin an older immutable version. New work omits this
   * field and resolves the aggregate's active current version.
   */
  readonly configurationVersionId?: string;
  readonly requiredCapability: ConnectorCapability;
}

/**
 * Private immutable connector configuration. `settings` and locator metadata
 * may be used only by trusted server-side adapter composition; neither may be
 * serialized to a browser, audit event, trace, log, or public DTO.
 */
export interface ServerPrivateConnectorConfiguration {
  readonly workspaceId: string;
  readonly connectorRegistrationId: string;
  readonly configurationVersionId: string;
  readonly descriptor: ConfigurationDescriptorReference;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferences: ReadonlyArray<
    Readonly<{ readonly locator: string }>
  >;
}

/**
 * Resolve a workspace-scoped active connector aggregate and one immutable
 * descriptor-backed version for trusted runtime composition only.
 */
export interface RuntimeConnectorConfigurationResolver {
  resolve(
    input: RuntimeConnectorConfigurationRequest,
  ): Promise<ServerPrivateConnectorConfiguration | undefined>;
}

/** Safe corruption/configuration failure; it deliberately carries no identifiers or locators. */
export class RuntimeConnectorConfigurationError extends Error {
  public readonly code = "runtime.connectorConfigurationUnavailable";

  public constructor() {
    super("Runtime connector configuration is unavailable.");
    this.name = "RuntimeConnectorConfigurationError";
  }
}
