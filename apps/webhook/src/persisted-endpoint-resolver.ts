import type {
  WebhookEndpointConfigurationReadPort,
  WebhookEndpointConfigurationState,
  WebhookEndpointRateLimiter,
} from "@caseweaver/administration";
import type { WebhookAdapter } from "@caseweaver/connector-sdk";
import type {
  ResolvedWebhookEndpoint,
  WebhookEndpointResolver,
} from "./app.js";

/**
 * Composition-owned adapter lookup.  It receives server-selected immutable
 * identities only, so a webhook body or header can never select an adapter,
 * workspace, endpoint configuration version, connector configuration version,
 * or credential.
 */
export interface WebhookAdapterResolver {
  resolve(
    input: Readonly<{
      readonly workspaceId: string;
      readonly connectorRegistrationId: string;
      readonly connectorConfigurationVersionId: string;
      readonly verifiedEventTypes: readonly string[];
    }>,
  ): Promise<WebhookAdapter | undefined>;
}

/**
 * Adapts PBI-016's safe endpoint projection to the existing public ingress
 * transport.  It intentionally does not read generic administration settings,
 * secret-reference locators, delivery headers, or request content.
 */
export class PersistedWebhookEndpointResolver
  implements WebhookEndpointResolver
{
  public constructor(
    private readonly endpoints: WebhookEndpointConfigurationReadPort,
    private readonly rateLimiter: WebhookEndpointRateLimiter,
    private readonly adapters: WebhookAdapterResolver,
  ) {}

  public async resolve(
    endpointId: string,
  ): Promise<ResolvedWebhookEndpoint | undefined> {
    const state = await this.endpoints.findActive({ endpointId });
    if (state === undefined) return undefined;

    const adapter = await this.adapters.resolve(adapterRequest(state));
    if (adapter === undefined) return undefined;

    return Object.freeze({
      endpoint: Object.freeze({
        id: state.endpointId,
        workspaceId: state.workspaceId,
        connectorInstanceId: state.connectorRegistrationId,
        endpointConfigurationVersionId: state.endpointConfigurationVersionId,
        connectorConfigurationVersionId: state.connectorConfigurationVersionId,
        adapter,
        ...(state.analysisTriggerId === undefined
          ? {}
          : { analysisTriggerId: state.analysisTriggerId }),
        ...(state.automatedPrincipalId === undefined
          ? {}
          : { automatedPrincipalId: state.automatedPrincipalId }),
      }),
      maximumBodyBytes: state.maximumBodyBytes,
      admit: () =>
        this.rateLimiter.acquire({
          workspaceId: state.workspaceId,
          endpointId: state.endpointId,
        }),
    });
  }
}

function adapterRequest(state: WebhookEndpointConfigurationState): Readonly<{
  readonly workspaceId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly verifiedEventTypes: readonly string[];
}> {
  return Object.freeze({
    workspaceId: state.workspaceId,
    connectorRegistrationId: state.connectorRegistrationId,
    connectorConfigurationVersionId: state.connectorConfigurationVersionId,
    verifiedEventTypes: state.verifiedEventTypes,
  });
}
