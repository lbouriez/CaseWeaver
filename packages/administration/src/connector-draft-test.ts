import type { Permission } from "@caseweaver/security";

/**
 * A server-only fingerprint of a candidate connector configuration.  It binds
 * a confirmation and idempotency claim without retaining settings, locator,
 * credential, response, or external error data.
 */
export interface ConnectorDraftTestIdentity {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly descriptorType: string;
  readonly descriptorVersion: string;
  readonly operation: string;
  readonly candidateDigest: string;
}

export interface ConnectorDraftTestAudit {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetType: "connector-descriptor";
  readonly permission: Permission;
  readonly outcome: "succeeded" | "failed" | "denied";
  readonly requestId: string;
  readonly correlationId: string;
  readonly idempotencyKeyDigest?: string;
  readonly uiActionId?: string;
  readonly traceId?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
  readonly occurredAt: string;
}

export interface ConnectorDraftTestPreview {
  readonly confirmationId: string;
  readonly confirmation: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export interface ConnectorDraftTestResult {
  readonly id: string;
  readonly outcome: "succeeded" | "failed" | "outcome_unknown";
  readonly completedAt: string;
}

/**
 * Durable boundary for an unactioned connector candidate test.  Implementors
 * retain only identities and hashes, atomically recording the required audit
 * event with confirmation issuance or terminal result persistence.
 */
export interface ConnectorDraftTestStore {
  issueAndRecord(
    input: Readonly<{
      readonly identity: ConnectorDraftTestIdentity;
      readonly audit: ConnectorDraftTestAudit;
      readonly now: string;
    }>,
  ): Promise<ConnectorDraftTestPreview>;
  consumeAndClaim(
    input: Readonly<{
      readonly identity: ConnectorDraftTestIdentity;
      readonly confirmationId: string;
      readonly idempotencyKeyDigest: string;
      readonly now: string;
    }>,
  ): Promise<
    | Readonly<{ readonly kind: "acquired"; readonly claimId: string }>
    | Readonly<{
        readonly kind: "replayed";
        readonly result: ConnectorDraftTestResult;
      }>
    | Readonly<{ readonly kind: "conflict" | "outcome_unknown" }>
  >;
  completeAndRecord(
    input: Readonly<{
      readonly claimId: string;
      readonly identity: ConnectorDraftTestIdentity;
      /** The durable adapter owns the terminal result identity. */
      readonly result: Omit<ConnectorDraftTestResult, "id">;
      readonly audit: ConnectorDraftTestAudit;
    }>,
  ): Promise<ConnectorDraftTestResult>;
}
