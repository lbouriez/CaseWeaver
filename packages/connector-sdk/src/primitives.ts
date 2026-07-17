import { type SecretReference, secretReference } from "@caseweaver/domain";
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

const opaqueAttachmentLocatorValueSchema = z
  .string()
  .min(1)
  // A sealed durable locator may contain a public image address. It remains
  // server-private and is deliberately larger than a normal opaque value so it
  // never requires an unsafe process-local reverse lookup during retries.
  .max(16_384)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Attachment locators must be URL-safe opaque tokens, not URLs or file paths.",
  );

/**
 * A connector-private, durable handle used only by trusted server-side attachment
 * source code to reopen an attachment occurrence. It deliberately accepts only an
 * opaque URL-safe token: URLs, host paths, credentials, and connector-specific
 * transport details must never become normalized records or public DTOs.
 */
export const attachmentLocatorSchema = z
  .object({
    version: opaqueValueVersionSchema,
    value: opaqueAttachmentLocatorValueSchema,
  })
  .strict();

export type AttachmentLocator = z.infer<typeof attachmentLocatorSchema>;

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
