import { secretReference, type SecretReference } from "@caseweaver/domain";
import { z } from "zod";

export const CONNECTOR_SCHEMA_VERSION = 1 as const;

const opaqueValueVersionSchema = z.string().min(1).max(100);
const opaqueValueSchema = z.string().min(1).max(4_096);

/**
 * A connector-defined value whose contents CaseWeaver persists and compares but never
 * interprets. The value version belongs to the connector, not to CaseWeaver.
 */
export const versionedOpaqueValueSchema = z
  .object({
    version: opaqueValueVersionSchema,
    value: opaqueValueSchema,
  })
  .strict();

export type VersionedOpaqueValue = z.infer<typeof versionedOpaqueValueSchema>;
export type ConnectorCursor = VersionedOpaqueValue;
export type ExternalFingerprint = VersionedOpaqueValue;
export type ExternalRevision = VersionedOpaqueValue;
export type SnapshotScanEpoch = VersionedOpaqueValue;

export function versionedOpaqueValue(
  version: string,
  value: string,
): VersionedOpaqueValue {
  return versionedOpaqueValueSchema.parse({ version, value });
}

export const connectorInstanceIdSchema = z.string().min(1).max(200);
export type ConnectorInstanceId = z.infer<typeof connectorInstanceIdSchema>;

export const externalReferenceSchema = z
  .object({
    connectorInstanceId: connectorInstanceIdSchema,
    resourceType: z.string().min(1).max(100),
    externalId: z.string().min(1).max(1_024),
  })
  .strict();

export type ExternalReference = z.infer<typeof externalReferenceSchema>;
export type CaseReference = ExternalReference;
export type AttachmentReference = ExternalReference;
export type KnowledgeReference = ExternalReference;

export const secretReferenceSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[^\s:]+:[^\s]+$/)
  .transform((value) => secretReference(value));

export type ConnectorSecretReference = SecretReference;

export interface OperationContext {
  readonly signal: AbortSignal;
  readonly requestId?: string;
}

export interface CursorPageRequest extends OperationContext {
  readonly cursor?: ConnectorCursor;
  readonly pageSize?: number;
}

export interface CursorPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: ConnectorCursor;
}
