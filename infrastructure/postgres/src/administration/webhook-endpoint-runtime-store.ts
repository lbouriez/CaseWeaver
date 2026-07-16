import {
  AdministrationValidationError,
  type WebhookEndpointConfigurationReadPort,
  type WebhookEndpointConfigurationState,
  type WebhookEndpointRateLimiter,
} from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Trusted ingress lookup for an opaque endpoint. This read path intentionally
 * returns no configuration settings, secret-reference locators, raw delivery
 * material, or connector adapter. Composition resolves an adapter separately
 * using the server-owned connector/version identities.
 */
export class PostgresWebhookEndpointRuntimeStore
  implements WebhookEndpointConfigurationReadPort, WebhookEndpointRateLimiter
{
  public constructor(private readonly client: PrismaClient) {}

  /**
   * A disabled endpoint is indistinguishable from an absent endpoint to a
   * public caller. The primary-key lookup remains workspace-neutral because an
   * endpoint ID is a globally opaque server-generated route identity.
   */
  public async findActive(
    input: Parameters<WebhookEndpointConfigurationReadPort["findActive"]>[0],
  ): Promise<WebhookEndpointConfigurationState | undefined> {
    const row = await this.client.webhookEndpoint.findFirst({
      where: { id: input.endpointId, lifecycle: "active" },
      select: {
        id: true,
        workspaceId: true,
        lifecycle: true,
        connectorInstanceId: true,
        endpointConfigurationVersionId: true,
        connectorConfigurationVersionId: true,
        verifiedEventTypes: true,
        maximumBodyBytes: true,
        maximumRequestsPerMinute: true,
        analysisTriggerId: true,
        automatedPrincipalId: true,
      },
    });
    if (row === null) return undefined;
    return toState(row);
  }

  /**
   * PostgreSQL owns the minute window and confirms that the endpoint remains
   * active at admission time. No route-provided timestamp can enlarge the
   * capacity window.
   */
  public async acquire(
    input: Parameters<WebhookEndpointRateLimiter["acquire"]>[0],
  ): Promise<Readonly<{ readonly allowed: boolean }>> {
    const rows = await this.client.$queryRaw<
      readonly Readonly<{ readonly acquired_count: number }>[]
    >`
      WITH endpoint AS MATERIALIZED (
        SELECT workspace_id, id, maximum_requests_per_minute
        FROM webhook_endpoints
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${input.endpointId}
          AND lifecycle = 'active'
        FOR UPDATE
      ),
      current_window AS (
        SELECT date_trunc('minute', statement_timestamp()) AS window_started_at
      )
      INSERT INTO webhook_endpoint_rate_windows (
        workspace_id, endpoint_id, window_started_at, acquired_count
      )
      SELECT
        endpoint.workspace_id,
        endpoint.id,
        current_window.window_started_at,
        1
      FROM endpoint
      CROSS JOIN current_window
      ON CONFLICT (workspace_id, endpoint_id, window_started_at) DO UPDATE
      SET acquired_count = webhook_endpoint_rate_windows.acquired_count + 1
      WHERE webhook_endpoint_rate_windows.acquired_count < (
        SELECT maximum_requests_per_minute FROM endpoint
      )
      RETURNING acquired_count
    `;
    return Object.freeze({ allowed: rows.length === 1 });
  }
}

function toState(
  row: Readonly<{
    readonly id: string;
    readonly workspaceId: string;
    readonly lifecycle: string;
    readonly connectorInstanceId: string;
    readonly endpointConfigurationVersionId: string;
    readonly connectorConfigurationVersionId: string | null;
    readonly verifiedEventTypes: Prisma.JsonValue;
    readonly maximumBodyBytes: number;
    readonly maximumRequestsPerMinute: number;
    readonly analysisTriggerId: string | null;
    readonly automatedPrincipalId: string | null;
  }>,
): WebhookEndpointConfigurationState {
  const eventTypes = parseEventTypes(row.verifiedEventTypes);
  if (
    row.lifecycle !== "active" ||
    !isIdentifier(row.id) ||
    !isIdentifier(row.workspaceId) ||
    !isIdentifier(row.connectorInstanceId) ||
    !isIdentifier(row.endpointConfigurationVersionId) ||
    !isIdentifier(row.connectorConfigurationVersionId) ||
    !Number.isSafeInteger(row.maximumBodyBytes) ||
    row.maximumBodyBytes < 1 ||
    row.maximumBodyBytes > 10 * 1024 * 1024 ||
    !Number.isSafeInteger(row.maximumRequestsPerMinute) ||
    row.maximumRequestsPerMinute < 1 ||
    row.maximumRequestsPerMinute > 10_000 ||
    (row.analysisTriggerId !== null && !isIdentifier(row.analysisTriggerId)) ||
    (row.analysisTriggerId !== null && !isIdentifier(row.automatedPrincipalId))
  ) {
    throw new AdministrationValidationError();
  }
  const state = {
    endpointId: row.id,
    workspaceId: row.workspaceId,
    lifecycle: "active" as const,
    connectorRegistrationId: row.connectorInstanceId,
    endpointConfigurationVersionId: row.endpointConfigurationVersionId,
    connectorConfigurationVersionId: row.connectorConfigurationVersionId,
    verifiedEventTypes: eventTypes,
    maximumBodyBytes: row.maximumBodyBytes,
    maximumRequestsPerMinute: row.maximumRequestsPerMinute,
  };
  if (row.analysisTriggerId === null) return Object.freeze(state);
  // The validation above narrows both values for an active trigger route.
  return Object.freeze({
    ...state,
    analysisTriggerId: row.analysisTriggerId,
    automatedPrincipalId: row.automatedPrincipalId as string,
  });
}

function parseEventTypes(value: Prisma.JsonValue): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    !value.every(isIdentifier) ||
    new Set(value).size !== value.length
  ) {
    throw new AdministrationValidationError();
  }
  return Object.freeze([...value]);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  );
}
