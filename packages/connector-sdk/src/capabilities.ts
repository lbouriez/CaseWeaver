import { ConnectorConfigurationError } from "./errors.js";
import type {
  AnalysisDestination,
  AttachmentSource,
  CaseSource,
  KnowledgeSource,
  WebhookAdapter,
} from "./ports.js";
import type { ConnectorInstanceId } from "./primitives.js";

export type ConnectorCapability =
  | "knowledgeSource"
  | "caseSource"
  | "attachmentSource"
  | "analysisDestination"
  | "webhookAdapter";

export interface ConnectorCapabilityPorts {
  readonly knowledgeSource: KnowledgeSource;
  readonly caseSource: CaseSource;
  readonly attachmentSource: AttachmentSource;
  readonly analysisDestination: AnalysisDestination;
  readonly webhookAdapter: WebhookAdapter;
}

export interface ConnectorRegistration {
  readonly instanceId: ConnectorInstanceId;
  readonly connectorType: string;
  readonly capabilities: Partial<ConnectorCapabilityPorts>;
  readonly supportedWebhookEventTypes?: readonly string[];
}

export class ConnectorCapabilityRegistry {
  private readonly registrations = new Map<
    ConnectorInstanceId,
    ConnectorRegistration
  >();

  public register(registration: ConnectorRegistration): void {
    if (this.registrations.has(registration.instanceId)) {
      throw new ConnectorConfigurationError(
        "A connector instance was registered more than once.",
        { connectorInstanceId: registration.instanceId },
      );
    }

    if (
      registration.supportedWebhookEventTypes !== undefined &&
      registration.capabilities.webhookAdapter === undefined
    ) {
      throw new ConnectorConfigurationError(
        "Webhook event types require a webhook adapter capability.",
        { connectorInstanceId: registration.instanceId },
      );
    }

    this.registrations.set(
      registration.instanceId,
      Object.freeze({
        ...registration,
        capabilities: Object.freeze({ ...registration.capabilities }),
        supportedWebhookEventTypes:
          registration.supportedWebhookEventTypes === undefined
            ? undefined
            : Object.freeze([...registration.supportedWebhookEventTypes]),
      }),
    );
  }

  public get(
    instanceId: ConnectorInstanceId,
  ): ConnectorRegistration | undefined {
    return this.registrations.get(instanceId);
  }

  public getCapability<TCapability extends ConnectorCapability>(
    instanceId: ConnectorInstanceId,
    capability: TCapability,
  ): ConnectorCapabilityPorts[TCapability] | undefined {
    return this.registrations.get(instanceId)?.capabilities[capability];
  }

  public hasCapability(
    instanceId: ConnectorInstanceId,
    capability: ConnectorCapability,
  ): boolean {
    return this.getCapability(instanceId, capability) !== undefined;
  }

  public list(): readonly ConnectorRegistration[] {
    return Object.freeze([...this.registrations.values()]);
  }
}
