import {
  RuntimeConnectorConfigurationError,
  type RuntimeConnectorConfigurationResolver,
  type ServerPrivateConnectorConfiguration,
} from "@caseweaver/administration";
import {
  type AnalysisDestination,
  type CaseSource,
  ConnectorCancelledError,
  type ConnectorCapability,
  ConnectorConfigurationError,
  type ConnectorSecretReference,
  type ConnectorSecretResolver,
  type KnowledgeSource,
} from "@caseweaver/connector-sdk";

export interface ConnectorRuntimeContribution {
  readonly descriptor: Readonly<{
    readonly kind: "connector";
    readonly type: string;
    readonly version: string;
  }>;
  create(
    input: Readonly<{
      readonly configuration: ServerPrivateConnectorConfiguration;
      readonly secrets: ConnectorSecretResolver;
    }>,
  ): Promise<ConnectorRuntimeCapabilities>;
}

export interface ConnectorRuntimeCapabilities {
  readonly knowledgeSource?: KnowledgeSource;
  readonly caseSource?: CaseSource;
  readonly analysisDestination?: AnalysisDestination;
}

export class RuntimeConnectorCapabilityUnavailableError extends Error {
  public readonly code = "runtime.connectorCapabilityUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Runtime connector capability is unavailable.");
    this.name = "RuntimeConnectorCapabilityUnavailableError";
  }
}

/**
 * Resolves an exact immutable connector pin before adapter construction. The
 * only selection key is the descriptor revision stored with that version.
 */
export class RuntimeConnectorCapabilityResolver {
  private readonly contributions: ReadonlyMap<
    string,
    ConnectorRuntimeContribution
  >;

  public constructor(
    private readonly configurations: RuntimeConnectorConfigurationResolver,
    contributions: readonly ConnectorRuntimeContribution[],
    private readonly secrets: ConnectorSecretResolver,
  ) {
    const registered = new Map<string, ConnectorRuntimeContribution>();
    for (const contribution of contributions) {
      assertDescriptor(contribution.descriptor);
      const key = descriptorKey(contribution.descriptor);
      if (registered.has(key)) {
        throw new RangeError(
          "Connector runtime contribution descriptor is duplicated.",
        );
      }
      registered.set(key, contribution);
    }
    this.contributions = registered;
  }

  public async resolveKnowledgeSource(
    input: ExactCapabilityRequest,
  ): Promise<KnowledgeSource> {
    const capabilities = await this.resolve(input, "knowledgeSource");
    if (capabilities.knowledgeSource === undefined) {
      throw new RuntimeConnectorCapabilityUnavailableError();
    }
    return capabilities.knowledgeSource;
  }

  public async resolveCaseSource(
    input: ExactCapabilityRequest,
  ): Promise<CaseSource> {
    const capabilities = await this.resolve(input, "caseSource");
    if (capabilities.caseSource === undefined) {
      throw new RuntimeConnectorCapabilityUnavailableError();
    }
    return capabilities.caseSource;
  }

  public async resolveAnalysisDestination(
    input: ExactCapabilityRequest,
  ): Promise<AnalysisDestination> {
    const capabilities = await this.resolve(input, "analysisDestination");
    if (capabilities.analysisDestination === undefined) {
      throw new RuntimeConnectorCapabilityUnavailableError();
    }
    return capabilities.analysisDestination;
  }

  private async resolve(
    input: ExactCapabilityRequest,
    requiredCapability: ConnectorCapability,
  ): Promise<ConnectorRuntimeCapabilities> {
    try {
      const configuration = await this.configurations.resolve({
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.connectorRegistrationId,
        configurationVersionId: input.connectorConfigurationVersionId,
        requiredCapability,
      });
      if (
        configuration === undefined ||
        configuration.workspaceId !== input.workspaceId ||
        configuration.connectorRegistrationId !==
          input.connectorRegistrationId ||
        configuration.configurationVersionId !==
          input.connectorConfigurationVersionId
      ) {
        throw new RuntimeConnectorCapabilityUnavailableError();
      }
      const contribution = this.contributions.get(
        descriptorKey(configuration.descriptor),
      );
      if (contribution === undefined) {
        throw new RuntimeConnectorCapabilityUnavailableError();
      }
      return await contribution.create({
        configuration,
        secrets: this.secrets,
      });
    } catch (error) {
      if (
        error instanceof RuntimeConnectorCapabilityUnavailableError ||
        error instanceof ConnectorCancelledError
      ) {
        throw error;
      }
      // Private settings, secret locators, and vendor parser messages are never
      // safe diagnostic data at this shared runtime boundary.
      if (error instanceof RuntimeConnectorConfigurationError) {
        throw new RuntimeConnectorCapabilityUnavailableError();
      }
      throw new RuntimeConnectorCapabilityUnavailableError();
    }
  }
}

export interface ExactCapabilityRequest {
  readonly workspaceId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
}

/** The local composition only permits explicit environment variable locators. */
export class EnvironmentConnectorSecretResolver
  implements ConnectorSecretResolver
{
  public constructor(private readonly environment: NodeJS.ProcessEnv) {}

  public async resolve(
    reference: ConnectorSecretReference,
    signal: AbortSignal,
  ): Promise<Readonly<{ readonly value: string }>> {
    if (signal.aborted) throw new ConnectorCancelledError();
    const variableName = /^env:([A-Z][A-Z0-9_]{0,127})$/u.exec(reference)?.[1];
    const value =
      variableName === undefined ? undefined : this.environment[variableName];
    if (value === undefined || value.length === 0) {
      throw new ConnectorConfigurationError(
        "A configured connector secret could not be resolved.",
      );
    }
    return Object.freeze({ value });
  }
}

function descriptorKey(
  input: Readonly<{
    readonly kind: string;
    readonly type: string;
    readonly version: string;
  }>,
): string {
  return JSON.stringify([input.kind, input.type, input.version]);
}

function assertDescriptor(
  input: Readonly<{
    readonly kind: string;
    readonly type: string;
    readonly version: string;
  }>,
): void {
  if (
    input.kind !== "connector" ||
    !isIdentifier(input.type) ||
    !isIdentifier(input.version)
  ) {
    throw new RangeError(
      "Connector runtime contribution descriptor is invalid.",
    );
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}
