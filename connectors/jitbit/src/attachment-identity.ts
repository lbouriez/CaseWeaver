import {
  type AttachmentOpenIdentity,
  ConnectorProtocolError,
  type ExternalReference,
} from "@caseweaver/connector-sdk";

const locatorVersion = "jitbit.attachment.v1";
const attachmentResourceType = "attachment";
const maximumIdentifierLength = 1_024;

function safeIdentifier(value: string): string {
  if (
    value.length === 0 ||
    value.length > maximumIdentifierLength ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new ConnectorProtocolError(
      "Jitbit returned an invalid attachment ID.",
    );
  }
  return value;
}

/**
 * The durable connector reference remains useful for older attachment callers. The
 * server-private locator below is used by occurrence-aware callers and is never an
 * API/browser value.
 */
export function jitbitAttachmentReference(
  connectorInstanceId: string,
  ticketId: string,
  attachmentId: string,
): ExternalReference {
  const externalId = `${safeIdentifier(ticketId)}:${safeIdentifier(attachmentId)}`;
  if (externalId.length > maximumIdentifierLength) {
    throw new ConnectorProtocolError(
      "Jitbit returned an invalid attachment ID.",
    );
  }
  return {
    connectorInstanceId,
    resourceType: attachmentResourceType,
    externalId,
  };
}

/**
 * Encodes only the Jitbit attachment ID, never a URL, local path, or credential.
 * The value is server-private and is validated again before a stream is opened.
 */
export function jitbitAttachmentLocator(attachmentId: string): Readonly<{
  readonly version: string;
  readonly value: string;
}> {
  const value = Buffer.from(safeIdentifier(attachmentId), "utf8").toString(
    "base64url",
  );
  if (value.length === 0 || value.length > 4_096) {
    throw new ConnectorProtocolError(
      "Jitbit returned an invalid attachment ID.",
    );
  }
  return { version: locatorVersion, value };
}

export function attachmentIdFromJitbitOpenIdentity(
  identity: AttachmentOpenIdentity,
  reference: ExternalReference,
  connectorInstanceId: string,
): string {
  if (
    identity.reference.connectorInstanceId !== connectorInstanceId ||
    identity.reference.resourceType !== attachmentResourceType ||
    !sameReference(identity.reference, reference) ||
    identity.locator.version !== locatorVersion ||
    !isJitbitAttachmentOwner(identity, connectorInstanceId)
  ) {
    throw new ConnectorProtocolError(
      "The requested attachment does not belong to Jitbit.",
    );
  }

  let attachmentId: string;
  try {
    attachmentId = Buffer.from(identity.locator.value, "base64url").toString(
      "utf8",
    );
  } catch {
    throw new ConnectorProtocolError("The requested attachment is invalid.");
  }
  if (
    Buffer.from(attachmentId, "utf8").toString("base64url") !==
    identity.locator.value
  ) {
    throw new ConnectorProtocolError("The requested attachment is invalid.");
  }
  const expected = jitbitAttachmentReference(
    connectorInstanceId,
    ticketIdFromOwner(identity),
    attachmentId,
  );
  if (!sameReference(expected, reference)) {
    throw new ConnectorProtocolError("The requested attachment is invalid.");
  }
  return attachmentId;
}

function isJitbitAttachmentOwner(
  identity: AttachmentOpenIdentity,
  connectorInstanceId: string,
): boolean {
  switch (identity.owner.kind) {
    case "case":
    case "caseMessage":
      return (
        identity.owner.case.connectorInstanceId === connectorInstanceId &&
        identity.owner.case.resourceType === "case"
      );
    case "knowledgeDocument":
      return (
        identity.owner.document.connectorInstanceId === connectorInstanceId &&
        identity.owner.document.resourceType === "resolved-case"
      );
  }
}

/** Compatibility for legacy metadata-only attachment callers. */
export function attachmentIdFromJitbitReference(
  reference: ExternalReference,
  connectorInstanceId: string,
): string {
  if (
    reference.connectorInstanceId !== connectorInstanceId ||
    reference.resourceType !== attachmentResourceType
  ) {
    throw new ConnectorProtocolError(
      "The requested attachment does not belong to Jitbit.",
    );
  }
  const delimiter = reference.externalId.lastIndexOf(":");
  if (delimiter < 1 || delimiter === reference.externalId.length - 1) {
    throw new ConnectorProtocolError("The requested attachment is invalid.");
  }
  return safeIdentifier(reference.externalId.slice(delimiter + 1));
}

function ticketIdFromOwner(identity: AttachmentOpenIdentity): string {
  switch (identity.owner.kind) {
    case "case":
    case "caseMessage":
      return safeIdentifier(identity.owner.case.externalId);
    case "knowledgeDocument":
      return safeIdentifier(identity.owner.document.externalId);
  }
}

function sameReference(
  left: ExternalReference,
  right: ExternalReference,
): boolean {
  return (
    left.connectorInstanceId === right.connectorInstanceId &&
    left.resourceType === right.resourceType &&
    left.externalId === right.externalId
  );
}
