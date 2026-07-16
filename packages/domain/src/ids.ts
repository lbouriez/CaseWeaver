import { DomainValidationError } from "./errors.js";

declare const opaqueBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueBrand]: Kind;
};

export type WorkspaceId = OpaqueId<"workspace">;
export type PrincipalId = OpaqueId<"principal">;
export type CredentialRegistrationId = OpaqueId<"credentialRegistration">;
export type ConnectorRegistrationId = OpaqueId<"connectorRegistration">;
export type ExternalReferenceId = OpaqueId<"externalReference">;
export type CaseSnapshotId = OpaqueId<"caseSnapshot">;
export type KnowledgeItemId = OpaqueId<"knowledgeItem">;
export type AttachmentId = OpaqueId<"attachment">;
export type AnalysisProfileId = OpaqueId<"analysisProfile">;
export type AnalysisProfileVersionId = OpaqueId<"analysisProfileVersion">;
export type AnalysisIdentityId = OpaqueId<"analysisIdentity">;
export type AnalysisJobId = OpaqueId<"analysisJob">;
export type AnalysisAttemptId = OpaqueId<"analysisAttempt">;
export type AnalysisResultId = OpaqueId<"analysisResult">;
export type AnalysisTriggerId = OpaqueId<"analysisTrigger">;
export type AnalysisTriggerVersionId = OpaqueId<"analysisTriggerVersion">;
export type AnalysisTriggerRequestId = OpaqueId<"analysisTriggerRequest">;
export type EvidenceId = OpaqueId<"evidence">;
export type PublicationIntentId = OpaqueId<"publicationIntent">;
export type PublicationAttemptId = OpaqueId<"publicationAttempt">;
export type AuditEventId = OpaqueId<"auditEvent">;
export type InboxMessageId = OpaqueId<"inboxMessage">;
export type OutboxEnvelopeId = OpaqueId<"outboxEnvelope">;
export type ResourceLeaseId = OpaqueId<"resourceLease">;
export type RequestId = OpaqueId<"request">;
export type CorrelationId = OpaqueId<"correlation">;
export type CausationId = OpaqueId<"causation">;
export type SecretReference = OpaqueId<"secretReference">;
export type Sha256Digest = OpaqueId<"sha256Digest">;
export type UtcInstant = OpaqueId<"utcInstant">;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const sha256Pattern = /^[a-fA-F0-9]{64}$/;

function opaque<Kind extends string>(
  value: string,
  kind: Kind,
): OpaqueId<Kind> {
  if (!identifierPattern.test(value)) {
    throw new DomainValidationError("Identifier is invalid.", { kind });
  }

  return value as OpaqueId<Kind>;
}

function identifierFactory<Kind extends string>(kind: Kind) {
  return (value: string): OpaqueId<Kind> => opaque(value, kind);
}

export const workspaceId = identifierFactory("workspace");
export const principalId = identifierFactory("principal");
export const credentialRegistrationId = identifierFactory(
  "credentialRegistration",
);
export const connectorRegistrationId = identifierFactory(
  "connectorRegistration",
);
export const externalReferenceId = identifierFactory("externalReference");
export const caseSnapshotId = identifierFactory("caseSnapshot");
export const knowledgeItemId = identifierFactory("knowledgeItem");
export const attachmentId = identifierFactory("attachment");
export const analysisProfileId = identifierFactory("analysisProfile");
export const analysisProfileVersionId = identifierFactory(
  "analysisProfileVersion",
);
export const analysisIdentityId = identifierFactory("analysisIdentity");
export const analysisJobId = identifierFactory("analysisJob");
export const analysisAttemptId = identifierFactory("analysisAttempt");
export const analysisResultId = identifierFactory("analysisResult");
export const analysisTriggerId = identifierFactory("analysisTrigger");
export const analysisTriggerVersionId = identifierFactory(
  "analysisTriggerVersion",
);
export const analysisTriggerRequestId = identifierFactory(
  "analysisTriggerRequest",
);
export const evidenceId = identifierFactory("evidence");
export const publicationIntentId = identifierFactory("publicationIntent");
export const publicationAttemptId = identifierFactory("publicationAttempt");
export const auditEventId = identifierFactory("auditEvent");
export const inboxMessageId = identifierFactory("inboxMessage");
export const outboxEnvelopeId = identifierFactory("outboxEnvelope");
export const resourceLeaseId = identifierFactory("resourceLease");
export const requestId = identifierFactory("request");
export const correlationId = identifierFactory("correlation");
export const causationId = identifierFactory("causation");

export function secretReference(value: string): SecretReference {
  if (
    value.length === 0 ||
    value.length > 512 ||
    /\s/.test(value) ||
    !value.includes(":")
  ) {
    throw new DomainValidationError("Secret reference is invalid.");
  }

  return value as SecretReference;
}

export function sha256Digest(value: string): Sha256Digest {
  if (!sha256Pattern.test(value)) {
    throw new DomainValidationError("SHA-256 digest is invalid.");
  }

  return value.toLowerCase() as Sha256Digest;
}

export function utcInstant(value: Date | string): UtcInstant {
  const rawValue = typeof value === "string" ? value : value.toISOString();
  if (!rawValue.endsWith("Z")) {
    throw new DomainValidationError("UTC instant must use a UTC offset.");
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainValidationError("UTC instant is invalid.");
  }

  return parsed.toISOString() as UtcInstant;
}
