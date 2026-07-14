import {
  externalReferenceSchema,
  type PublicationMarker,
  sha256CanonicalJson,
} from "@caseweaver/connector-sdk";
import { sha256Digest } from "@caseweaver/domain";
import { z } from "zod";

const identifier = z.string().min(1).max(200);
const markerPrefix = "caseweaver.publication.v1.";

export const publicationIdentityInputSchema = z
  .object({
    workspaceId: identifier,
    analysisResultId: identifier,
    publicationProfileId: identifier,
    publicationProfileVersion: identifier,
    destinationConnectorInstanceId: identifier,
    target: externalReferenceSchema,
  })
  .strict();

export type PublicationIdentityInput = z.infer<
  typeof publicationIdentityInputSchema
>;

export interface PublicationIdentity {
  readonly identityHash: string;
  readonly marker: PublicationMarker;
  readonly idempotencyKey: string;
  readonly requestHash: ReturnType<typeof sha256CanonicalJson>;
}

export function publicationDeliveryIdentity(
  identityHash: string,
): Omit<PublicationIdentity, "identityHash"> {
  const digest = sha256Digest(identityHash);
  return Object.freeze({
    marker: Object.freeze({
      value: `${markerPrefix}${digest}`,
    }),
    idempotencyKey: `publication.v1.${digest}`,
    requestHash: sha256CanonicalJson({
      operation: "publication.publish.v1",
      identityHash: digest,
    }),
  });
}

/**
 * A publication identity includes every immutable choice that can make a
 * destination write distinct. The marker intentionally contains only its
 * digest, so no case or workspace identifier leaks into remote content.
 */
export function createPublicationIdentity(
  input: PublicationIdentityInput,
): PublicationIdentity {
  const parsed = publicationIdentityInputSchema.parse(input);
  const identityHash = sha256CanonicalJson({
    operation: "publication.identity.v1",
    workspaceId: parsed.workspaceId,
    analysisResultId: parsed.analysisResultId,
    publicationProfileId: parsed.publicationProfileId,
    publicationProfileVersion: parsed.publicationProfileVersion,
    destinationConnectorInstanceId: parsed.destinationConnectorInstanceId,
    target: parsed.target,
  });

  return Object.freeze({
    identityHash,
    ...publicationDeliveryIdentity(identityHash),
  });
}
