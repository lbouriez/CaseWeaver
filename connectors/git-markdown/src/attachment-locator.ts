import {
  type AttachmentLocator,
  attachmentLocatorSchema,
  ConnectorProtocolError,
  sha256CanonicalJson,
} from "@caseweaver/connector-sdk";
import { z } from "zod";

import { gitObjectIdSchema, repositoryPathSchema } from "./git-repository.js";

const publicHttpsUrlSchema = z
  .string()
  .max(8_192)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Public image references must use HTTPS.",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Public image references must not contain credentials.",
      });
    }
  });

const repositoryFileAddressSchema = z
  .object({
    kind: z.literal("repositoryFile"),
    connectorInstanceId: z.string().min(1).max(200),
    commitSha: gitObjectIdSchema,
    /** The containing immutable Markdown document. */
    sourcePath: repositoryPathSchema,
    path: repositoryPathSchema,
    ordinal: z.number().int().nonnegative().max(1_000_000),
    relation: z.enum(["inlineImage", "inlineFile"]),
  })
  .strict();

const publicHttpsImageAddressSchema = z
  .object({
    kind: z.literal("publicHttpsImage"),
    connectorInstanceId: z.string().min(1).max(200),
    commitSha: gitObjectIdSchema,
    /** The containing immutable Markdown document, never a filesystem path. */
    sourcePath: repositoryPathSchema,
    ordinal: z.number().int().nonnegative().max(1_000_000),
    relation: z.literal("inlineImage"),
    /** Server-private until the injected codec seals it. */
    url: publicHttpsUrlSchema,
  })
  .strict();

export const gitMarkdownAttachmentAddressSchema = z.discriminatedUnion("kind", [
  repositoryFileAddressSchema,
  publicHttpsImageAddressSchema,
]);

/**
 * This plaintext shape exists only between this connector and a trusted locator
 * codec. It must never be persisted or mapped into an API, audit, log, or trace
 * payload. The codec returns a URL-safe opaque token instead.
 */
export type GitMarkdownAttachmentAddress = z.infer<
  typeof gitMarkdownAttachmentAddressSchema
>;

/**
 * Trusted composition supplies a sealed, authenticated codec. The connector owns
 * the address semantics; encryption/signing key lifecycle remains outside it.
 */
export interface GitMarkdownAttachmentLocatorCodec {
  seal(
    address: GitMarkdownAttachmentAddress,
    signal: AbortSignal,
  ): Promise<AttachmentLocator>;
  open(
    locator: AttachmentLocator,
    signal: AbortSignal,
  ): Promise<GitMarkdownAttachmentAddress>;
}

export function parseGitMarkdownAttachmentAddress(
  value: unknown,
): GitMarkdownAttachmentAddress {
  const result = gitMarkdownAttachmentAddressSchema.safeParse(value);
  if (!result.success) {
    throw invalidAttachmentIdentity();
  }
  return result.data;
}

export function parseGitMarkdownAttachmentLocator(
  value: unknown,
): AttachmentLocator {
  const result = attachmentLocatorSchema.safeParse(value);
  if (!result.success) {
    throw invalidAttachmentIdentity();
  }
  return result.data;
}

/**
 * Returns the bounded public reference for a sealed locator without retaining the
 * locator itself as an external identifier. The locator is server-private and may be
 * much larger than an ExternalReference id; this digest lets an open request bind the
 * reference to the exact opaque locator without exposing paths or public image URLs.
 */
export function gitMarkdownAttachmentReferenceId(
  locator: AttachmentLocator,
): string {
  return `locator-${sha256CanonicalJson({
    version: locator.version,
    value: locator.value,
  })}`;
}

/** A deliberately generic failure that cannot disclose a locator or address. */
export function invalidAttachmentIdentity(): ConnectorProtocolError {
  return new ConnectorProtocolError(
    "The Git Markdown attachment identity is invalid or unavailable.",
  );
}
