import type { MutationIdentity } from "./configuration.js";
import type {
  AdministrationTransactionRunner,
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
  ConfigurationTransitionResult,
} from "./configuration-lifecycle.js";
import {
  CreateConfigurationDraft,
  TransitionConfigurationVersion,
} from "./configuration-lifecycle.js";

/** Stable generic configuration resource name; it is not a public ingress URL. */
export const webhookEndpointConfigurationResource = "webhook-endpoints";

export interface WebhookEndpointConfigurationProjection {
  /** Opaque server-generated ingress identity. */
  readonly endpointId: string;
  readonly connectorRegistrationId: string;
  readonly verifiedEventTypes: readonly string[];
  readonly maximumBodyBytes: number;
  readonly maximumRequestsPerMinute: number;
  /** Optional server-resolved case-analysis trigger; never comes from a body/header. */
  readonly analysisTriggerId?: string;
}

/**
 * Safe, server-only routing state for an opaque public ingress identifier.
 * This deliberately excludes settings, secret-reference locators, request
 * headers/bodies, and any connector adapter implementation.
 */
export interface WebhookEndpointConfigurationState {
  readonly endpointId: string;
  readonly workspaceId: string;
  readonly lifecycle: "active" | "disabled";
  readonly connectorRegistrationId: string;
  /** Immutable endpoint version that selected this public routing state. */
  readonly endpointConfigurationVersionId: string;
  /** Immutable connector version that selects the private webhook adapter. */
  readonly connectorConfigurationVersionId: string;
  readonly verifiedEventTypes: readonly string[];
  readonly maximumBodyBytes: number;
  readonly maximumRequestsPerMinute: number;
  readonly analysisTriggerId?: string;
  /**
   * Server-owned principal captured when analysis-trigger routing was activated.
   * It is intentionally absent from administration projections and HTTP DTOs.
   */
  readonly automatedPrincipalId?: string;
}

/**
 * Trusted ingress composition resolves an opaque endpoint through this port.
 * It is intentionally separate from administration UI reads: it exposes no
 * configuration settings or secret-reference identities.
 */
export interface WebhookEndpointConfigurationReadPort {
  findActive(
    input: Readonly<{ readonly endpointId: string }>,
  ): Promise<WebhookEndpointConfigurationState | undefined>;
}

/**
 * Database-time admission control for a public endpoint. A denial is not a
 * failure and must not invoke a connector adapter or create a delivery record.
 */
export interface WebhookEndpointRateLimiter {
  acquire(
    input: Readonly<{
      readonly workspaceId: string;
      readonly endpointId: string;
    }>,
  ): Promise<Readonly<{ readonly allowed: boolean }>>;
}

/**
 * `secretReferenceLocators` are deployment-secret-backend locators resolved by
 * the API from one-time registration identities. They never appear in an HTTP
 * DTO, public URL, audit record, or generic resource read model.
 */
export interface CreateWebhookEndpointConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly projection: WebhookEndpointConfigurationProjection;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceLocators: readonly string[];
  readonly mutation: MutationIdentity;
}

export interface TransitionWebhookEndpointConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly projection: WebhookEndpointConfigurationProjection;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceLocators: readonly string[];
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  /**
   * Authorization context supplied by the API, never a projected endpoint
   * property or untrusted webhook input. An active trigger route requires it.
   */
  readonly automatedPrincipalId?: string;
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

/**
 * A durable adapter verifies connector capability/descriptor event types and
 * writes endpoint projection state in the same transaction as the configuration
 * version, idempotency result, authoritative audit event, and cache notice.
 */
export interface WebhookEndpointConfigurationProjectionStore
  extends ConfigurationLifecycleStore {
  writeWebhookEndpoint(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "active" | "disabled";
      readonly endpoint: WebhookEndpointConfigurationProjection;
      readonly automatedPrincipalId?: string;
    }>,
  ): Promise<void>;
}

/**
 * The administration layer owns endpoint lifecycle only. It never receives
 * webhook bodies or headers, invokes connector verification, or queues work.
 */
export class ManageWebhookEndpointConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: WebhookEndpointConfigurationProjectionStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async create(
    command: CreateWebhookEndpointConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertProjection(command.projection);
    assertSettings(command.settings);
    assertOpaqueLocators(command.secretReferenceLocators);
    return this.transactions.transaction(async () => {
      const created = await new CreateConfigurationDraft(
        passthroughTransaction,
        this.store,
        webhookAudit(this.audit, "admin.webhookEndpoint.draft.created"),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.projection.endpointId,
        resourceType: webhookEndpointConfigurationResource,
        displayName: command.displayName,
        settings: command.settings,
        secretReferenceIds: uniqueLocators(command.secretReferenceLocators),
        mutation: command.mutation,
      });
      // Draft endpoints intentionally have no public ingress projection.
      return created;
    });
  }

  public async transition(
    command: TransitionWebhookEndpointConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertProjection(command.projection);
    assertSettings(command.settings);
    assertOpaqueLocators(command.secretReferenceLocators);
    assertAutomatedPrincipal(command);
    if (
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 1
    ) {
      throw new RangeError("Webhook endpoint expected revision is invalid.");
    }
    return this.transactions.transaction(async () => {
      const transitioned = await new TransitionConfigurationVersion(
        passthroughTransaction,
        this.store,
        webhookAudit(this.audit, "admin.webhookEndpoint.configuration.changed"),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.projection.endpointId,
        resourceType: webhookEndpointConfigurationResource,
        expectedRevision: command.expectedRevision,
        settings: command.settings,
        secretReferenceIds: uniqueLocators(command.secretReferenceLocators),
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        lifecycle: command.lifecycle,
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        mutation: command.mutation,
      });
      if (transitioned.idempotency === "created") {
        await this.store.writeWebhookEndpoint({
          workspaceId: command.workspaceId,
          configurationVersionId: transitioned.version.id,
          lifecycle: command.lifecycle,
          endpoint: command.projection,
          ...(command.automatedPrincipalId === undefined
            ? {}
            : { automatedPrincipalId: command.automatedPrincipalId }),
        });
      }
      return transitioned;
    });
  }
}

function assertAutomatedPrincipal(
  command: TransitionWebhookEndpointConfigurationCommand,
): void {
  if (
    command.lifecycle === "active" &&
    command.projection.analysisTriggerId !== undefined
  ) {
    assertIdentifier(
      command.automatedPrincipalId,
      "Webhook automated principal identifier",
    );
    return;
  }
  if (command.automatedPrincipalId !== undefined) {
    assertIdentifier(
      command.automatedPrincipalId,
      "Webhook automated principal identifier",
    );
  }
}

const passthroughTransaction: AdministrationTransactionRunner = Object.freeze({
  transaction: async <T>(operation: () => Promise<T>) => operation(),
});

function webhookAudit(
  audit: ConfigurationLifecycleAudit,
  action: string,
): ConfigurationLifecycleAudit {
  return Object.freeze({
    append: (input: Parameters<ConfigurationLifecycleAudit["append"]>[0]) =>
      audit.append({ ...input, action }),
  });
}

function assertProjection(
  endpoint: WebhookEndpointConfigurationProjection,
): void {
  if (!isEndpointId(endpoint.endpointId)) {
    throw new RangeError("Webhook endpoint identifier is invalid.");
  }
  assertIdentifier(
    endpoint.connectorRegistrationId,
    "Webhook connector identifier",
  );
  if (
    endpoint.analysisTriggerId !== undefined &&
    !isIdentifier(endpoint.analysisTriggerId)
  ) {
    throw new RangeError("Webhook analysis trigger identifier is invalid.");
  }
  if (
    endpoint.verifiedEventTypes.length < 1 ||
    endpoint.verifiedEventTypes.length > 100 ||
    new Set(endpoint.verifiedEventTypes).size !==
      endpoint.verifiedEventTypes.length ||
    !endpoint.verifiedEventTypes.every(isIdentifier)
  ) {
    throw new RangeError("Webhook verified event types are invalid.");
  }
  if (
    !Number.isSafeInteger(endpoint.maximumBodyBytes) ||
    endpoint.maximumBodyBytes < 1 ||
    endpoint.maximumBodyBytes > 10 * 1024 * 1024
  ) {
    throw new RangeError("Webhook maximum body size is invalid.");
  }
  if (
    !Number.isSafeInteger(endpoint.maximumRequestsPerMinute) ||
    endpoint.maximumRequestsPerMinute < 1 ||
    endpoint.maximumRequestsPerMinute > 10_000
  ) {
    throw new RangeError("Webhook rate limit is invalid.");
  }
}

function assertSettings(value: Readonly<Record<string, unknown>>): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Webhook endpoint settings are invalid.");
  }
}

function assertOpaqueLocators(locators: readonly string[]): void {
  if (
    locators.length > 30 ||
    !locators.every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 500,
    )
  ) {
    throw new RangeError("Webhook secret reference locators are invalid.");
  }
}

function uniqueLocators(locators: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(locators)].sort());
}

function isEndpointId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  );
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isIdentifier(value)) throw new RangeError(`${label} is invalid.`);
}
