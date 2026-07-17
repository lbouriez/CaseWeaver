import { z } from "zod";

import {
  attachmentLocatorSchema,
  type ExternalReference,
  externalReferenceSchema,
  versionedOpaqueValueSchema,
} from "./primitives.js";

const optionalTextSchema = z.string().max(100_000).optional();
const safeSourceTextSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      }),
    "Source metadata must not contain control characters.",
  );
const safeSourceUrlSchema = z
  .string()
  .max(8_192)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Source URLs must use HTTP or HTTPS.",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Source URLs must not contain credentials.",
      });
    }
  });
const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Timestamp must be UTC.");

export const messageVisibilitySchema = z.enum(["public", "internal", "system"]);
export type MessageVisibility = z.infer<typeof messageVisibilitySchema>;

export const messageBodySchema = z
  .object({
    format: z.enum(["plainText", "html", "markdown"]),
    normalizedText: z.string().max(1_000_000),
    original: optionalTextSchema,
  })
  .strict();
export type NormalizedMessageBody = z.infer<typeof messageBodySchema>;

export const actorSchema = z
  .object({
    externalId: z.string().min(1).max(1_024).optional(),
    displayName: z.string().min(1).max(1_000).optional(),
    kind: z.enum(["person", "organization", "service"]).optional(),
  })
  .strict();
export type NormalizedActor = z.infer<typeof actorSchema>;

const attachmentFileNameSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      }),
    "Attachment file names must be a single safe name, not a path.",
  );
const declaredMediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/,
    "Declared media types must be MIME values.",
  )
  .transform((value) => value.toLowerCase());
const sha256ContentHashSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/)
  .transform((value) => value.toLowerCase());

/**
 * Safe, source-declared attachment properties. They are hints only: the attachment
 * pipeline still establishes the authoritative byte length, SHA-256, and MIME type.
 */
export const attachmentDeclaredMetadataSchema = z
  .object({
    fileName: attachmentFileNameSchema.optional(),
    mediaType: declaredMediaTypeSchema.optional(),
    contentLength: z.number().int().nonnegative().optional(),
    contentHash: sha256ContentHashSchema.optional(),
    externalRevision: versionedOpaqueValueSchema.optional(),
  })
  .strict();

export type AttachmentDeclaredMetadata = z.infer<
  typeof attachmentDeclaredMetadataSchema
>;

/**
 * Legacy reference-only attachment declaration. It remains intentionally compatible
 * with existing connectors; new occurrence records use the stricter safe declared
 * metadata schema above.
 */
export const attachmentMetadataSchema = z
  .object({
    reference: externalReferenceSchema,
    fileName: z.string().min(1).max(1_024).optional(),
    mediaType: z.string().min(1).max(255).optional(),
    contentLength: z.number().int().nonnegative().optional(),
    contentHash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    externalRevision: versionedOpaqueValueSchema.optional(),
  })
  .strict();
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

export const attachmentRelationSchema = z.enum([
  "declaredAttachment",
  "inlineImage",
  "inlineFile",
]);
export type AttachmentRelation = z.infer<typeof attachmentRelationSchema>;

export const attachmentOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("knowledgeDocument"),
      document: externalReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("case"),
      case: externalReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("caseMessage"),
      case: externalReferenceSchema,
      messageExternalId: z.string().min(1).max(1_024),
    })
    .strict(),
]);
export type AttachmentOwner = z.infer<typeof attachmentOwnerSchema>;

const attachmentOrdinalSchema = z.number().int().nonnegative().max(1_000_000);

function ownerReference(owner: AttachmentOwner): ExternalReference {
  return owner.kind === "knowledgeDocument" ? owner.document : owner.case;
}

function sameExternalReference(
  left: ExternalReference,
  right: ExternalReference,
): boolean {
  return (
    left.connectorInstanceId === right.connectorInstanceId &&
    left.resourceType === right.resourceType &&
    left.externalId === right.externalId
  );
}

/**
 * Server-private data required to reopen a discovered attachment through the same
 * trusted connector instance. This is never an HTTP/API/admin DTO. `locator` is an
 * opaque token, not a URL or local path, and must not be logged.
 */
export const attachmentOpenIdentitySchema = z
  .object({
    owner: attachmentOwnerSchema,
    ordinal: attachmentOrdinalSchema,
    relation: attachmentRelationSchema,
    reference: externalReferenceSchema,
    locator: attachmentLocatorSchema,
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      identity.reference.connectorInstanceId !==
      ownerReference(identity.owner).connectorInstanceId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Attachment references must belong to the connector that owns the occurrence.",
        path: ["reference", "connectorInstanceId"],
      });
    }
  });
export type AttachmentOpenIdentity = z.infer<
  typeof attachmentOpenIdentitySchema
>;

/**
 * One observed attachment location. A binary may appear more than once, so its stable
 * owner, relationship, and ordinal are retained separately from the external
 * attachment reference. Declared metadata remains optional because adapters must not
 * fabricate remote properties they do not expose.
 */
export const attachmentOccurrenceSchema = attachmentOpenIdentitySchema
  .extend({
    declared: attachmentDeclaredMetadataSchema.optional(),
  })
  .strict();
export type AttachmentOccurrence = z.infer<typeof attachmentOccurrenceSchema>;

function validateOccurrenceOrdinals(
  occurrences: readonly AttachmentOccurrence[] | undefined,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (occurrences === undefined) return;

  const seen = new Set<number>();
  for (const [index, occurrence] of occurrences.entries()) {
    if (seen.has(occurrence.ordinal)) {
      context.addIssue({
        code: "custom",
        message: "Attachment occurrence ordinals must be unique for one owner.",
        path: [...path, index, "ordinal"],
      });
    }
    seen.add(occurrence.ordinal);
  }
}

export const caseMessageSchema = z
  .object({
    externalId: z.string().min(1).max(1_024),
    sequence: z.number().int().nonnegative(),
    author: actorSchema.optional(),
    sentAt: utcTimestampSchema.optional(),
    visibility: messageVisibilitySchema,
    body: messageBodySchema,
    externalRevision: versionedOpaqueValueSchema.optional(),
    attachments: z.array(attachmentMetadataSchema).default([]),
    attachmentOccurrences: z.array(attachmentOccurrenceSchema).optional(),
  })
  .strict();
export type NormalizedCaseMessage = z.infer<typeof caseMessageSchema>;

export const caseAccessSchema = z
  .object({
    scope: z.enum(["workspace", "restricted"]),
    principals: z.array(actorSchema).optional(),
    groups: z.array(externalReferenceSchema).optional(),
  })
  .strict();
export type CaseAccess = z.infer<typeof caseAccessSchema>;

export const caseResolutionSchema = z
  .object({
    kind: z.enum([
      "fixed",
      "workaround",
      "duplicate",
      "notReproducible",
      "notResolved",
    ]),
    summary: z.string().max(100_000).optional(),
  })
  .strict();
export type CaseResolution = z.infer<typeof caseResolutionSchema>;

const caseActorsSchema = z
  .object({
    requester: actorSchema.optional(),
    assignee: actorSchema.optional(),
    participants: z.array(actorSchema).optional(),
    tenant: actorSchema.optional(),
    company: actorSchema.optional(),
  })
  .strict();

const caseTimestampsSchema = z
  .object({
    createdAt: utcTimestampSchema.optional(),
    updatedAt: utcTimestampSchema.optional(),
    resolvedAt: utcTimestampSchema.optional(),
    closedAt: utcTimestampSchema.optional(),
  })
  .strict();

/**
 * The neutral, vendor-field-free case shape. Connector metadata may be added only with
 * createNormalizedCaseSchema(), which requires the connector to provide its own schema.
 */
export const normalizedCaseSchema = z
  .object({
    reference: externalReferenceSchema,
    externalRevision: versionedOpaqueValueSchema.optional(),
    subject: z.string().max(10_000).optional(),
    lifecycle: z
      .enum(["new", "open", "pending", "resolved", "closed"])
      .optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    category: z.string().min(1).max(1_000).optional(),
    tags: z.array(z.string().min(1).max(1_000)).optional(),
    actors: caseActorsSchema.optional(),
    timestamps: caseTimestampsSchema.optional(),
    messages: z.array(caseMessageSchema),
    attachments: z.array(attachmentMetadataSchema).default([]),
    attachmentOccurrences: z.array(attachmentOccurrenceSchema).optional(),
    access: caseAccessSchema.optional(),
    resolution: caseResolutionSchema.optional(),
  })
  .strict()
  .superRefine((caseSnapshot, context) => {
    let previousSequence = -1;
    const messageExternalIds = new Set<string>();
    for (const [index, message] of caseSnapshot.messages.entries()) {
      if (message.sequence <= previousSequence) {
        context.addIssue({
          code: "custom",
          message: "Messages must have strictly increasing sequence values.",
          path: ["messages", index, "sequence"],
        });
      }
      previousSequence = message.sequence;

      if (messageExternalIds.has(message.externalId)) {
        context.addIssue({
          code: "custom",
          message: "Case message external IDs must be unique.",
          path: ["messages", index, "externalId"],
        });
      }
      messageExternalIds.add(message.externalId);

      validateOccurrenceOrdinals(message.attachmentOccurrences, context, [
        "messages",
        index,
        "attachmentOccurrences",
      ]);
      for (const [occurrenceIndex, occurrence] of (
        message.attachmentOccurrences ?? []
      ).entries()) {
        if (
          occurrence.owner.kind !== "caseMessage" ||
          !sameExternalReference(
            occurrence.owner.case,
            caseSnapshot.reference,
          ) ||
          occurrence.owner.messageExternalId !== message.externalId
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Message attachment occurrences must name their containing case and message.",
            path: [
              "messages",
              index,
              "attachmentOccurrences",
              occurrenceIndex,
              "owner",
            ],
          });
        }
      }
    }

    validateOccurrenceOrdinals(caseSnapshot.attachmentOccurrences, context, [
      "attachmentOccurrences",
    ]);
    for (const [index, occurrence] of (
      caseSnapshot.attachmentOccurrences ?? []
    ).entries()) {
      if (
        occurrence.owner.kind !== "case" ||
        !sameExternalReference(occurrence.owner.case, caseSnapshot.reference)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Case attachment occurrences must name their containing case as the owner.",
          path: ["attachmentOccurrences", index, "owner"],
        });
      }
    }
  });

export type NormalizedCase = z.infer<typeof normalizedCaseSchema>;

export function createNormalizedCaseSchema<TMetadata extends z.ZodType>(
  metadataSchema: TMetadata,
) {
  return normalizedCaseSchema.extend({
    connectorMetadata: metadataSchema.optional(),
  });
}

/**
 * Source-neutral evidence about where knowledge content came from. Values are
 * bounded and safe to persist; their versioned contents remain connector-opaque.
 */
export const knowledgeProvenanceSchema = z
  .object({
    sourceUrl: safeSourceUrlSchema.optional(),
    sourceLocator: safeSourceTextSchema.optional(),
    contentIdentity: versionedOpaqueValueSchema.optional(),
  })
  .strict();
export type KnowledgeProvenance = z.infer<typeof knowledgeProvenanceSchema>;

/**
 * A source-defined location within a document, such as a heading or page section.
 */
export const sourceAnchorSchema = z
  .object({
    anchor: safeSourceTextSchema.max(512),
    label: safeSourceTextSchema.optional(),
    position: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();
export type SourceAnchor = z.infer<typeof sourceAnchorSchema>;

export const knowledgeDocumentSchema = z
  .object({
    reference: externalReferenceSchema,
    externalRevision: versionedOpaqueValueSchema.optional(),
    title: z.string().max(10_000).optional(),
    body: messageBodySchema,
    attachments: z.array(attachmentMetadataSchema).default([]),
    attachmentOccurrences: z.array(attachmentOccurrenceSchema).optional(),
    access: caseAccessSchema.optional(),
    provenance: knowledgeProvenanceSchema.optional(),
    sourceAnchors: z.array(sourceAnchorSchema).max(10_000).optional(),
  })
  .strict()
  .superRefine((document, context) => {
    validateOccurrenceOrdinals(document.attachmentOccurrences, context, [
      "attachmentOccurrences",
    ]);
    for (const [index, occurrence] of (
      document.attachmentOccurrences ?? []
    ).entries()) {
      if (
        occurrence.owner.kind !== "knowledgeDocument" ||
        !sameExternalReference(occurrence.owner.document, document.reference)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Knowledge attachment occurrences must name their containing document as the owner.",
          path: ["attachmentOccurrences", index, "owner"],
        });
      }
    }
  });
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const discoveredKnowledgeItemSchema = z
  .object({
    reference: externalReferenceSchema,
    fingerprint: versionedOpaqueValueSchema.optional(),
    externalRevision: versionedOpaqueValueSchema.optional(),
    loadToken: versionedOpaqueValueSchema.optional(),
  })
  .strict();
export type DiscoveredKnowledgeItem = z.infer<
  typeof discoveredKnowledgeItemSchema
>;

export const discoveredCaseSchema = z
  .object({
    reference: externalReferenceSchema,
    fingerprint: versionedOpaqueValueSchema.optional(),
  })
  .strict();
export type DiscoveredCase = z.infer<typeof discoveredCaseSchema>;

export interface SnapshotDiscoveryPage<TItem> {
  readonly mode: "snapshot";
  readonly scanEpoch: z.infer<typeof versionedOpaqueValueSchema>;
  readonly items: readonly TItem[];
  readonly nextCursor?: z.infer<typeof versionedOpaqueValueSchema>;
  readonly complete: boolean;
}

export type DeltaDiscoveryEvent<TItem> =
  | Readonly<{ kind: "upsert"; item: TItem }>
  | Readonly<{ kind: "tombstone"; reference: ExternalReference }>;

export interface DeltaDiscoveryPage<TItem> {
  readonly mode: "delta";
  readonly events: readonly DeltaDiscoveryEvent<TItem>[];
  readonly nextCursor?: z.infer<typeof versionedOpaqueValueSchema>;
  readonly complete: boolean;
}

export type DiscoveryPage<TItem> =
  | SnapshotDiscoveryPage<TItem>
  | DeltaDiscoveryPage<TItem>;
