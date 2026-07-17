import {
  type AttachmentMetadata,
  type AttachmentOccurrence,
  type AttachmentOwner,
  ConnectorProtocolError,
  type ExternalReference,
  type KnowledgeDocument,
  type NormalizedActor,
  type NormalizedCase,
  type NormalizedCaseMessage,
  sha256CanonicalJson,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";

import {
  jitbitAttachmentLocator,
  jitbitAttachmentReference,
} from "./attachment-identity.js";
import type {
  JitbitComment,
  JitbitTicket,
  JitbitTicketSummary,
} from "./schemas.js";

const publicationMarkerPrefix = "<!-- caseweaver-publication:";
const publicationMarkerSuffix = " -->";
const publicationMarkerPattern =
  /<!-- caseweaver-publication:[A-Za-z0-9][A-Za-z0-9._:-]{0,511} -->/u;
const publicationMarkerValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

export const jitbitResolvedStatuses = new Set([
  "closed",
  "resolved",
  "done",
  "completed",
  "solved",
  "cancelled",
]);

function normalizeStatus(status: string | undefined): string | undefined {
  const normalized = status?.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

export function isResolvedSummary(summary: JitbitTicketSummary): boolean {
  const status = normalizeStatus(summary.Status);
  return status !== undefined && jitbitResolvedStatuses.has(status);
}

function lifecycleFor(status: string | undefined): NormalizedCase["lifecycle"] {
  switch (normalizeStatus(status)) {
    case "new":
      return "new";
    case "pending":
      return "pending";
    case "resolved":
    case "done":
    case "completed":
    case "solved":
      return "resolved";
    case "closed":
    case "cancelled":
      return "closed";
    default:
      return "open";
  }
}

function priorityFor(
  priority: string | undefined,
): NormalizedCase["priority"] | undefined {
  switch (normalizeStatus(priority)) {
    case "low":
      return "low";
    case "high":
      return "high";
    case "urgent":
    case "critical":
      return "urgent";
    case "normal":
    case "medium":
      return "normal";
    default:
      return undefined;
  }
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized =
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? value
      : `${value}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp)
    ? undefined
    : new Date(timestamp).toISOString();
}

function normalizeHtml(
  value: string | undefined,
  maximumLength: number,
): string {
  if (value === undefined) return "";
  if (value.length > maximumLength) {
    throw new ConnectorProtocolError(
      "Jitbit text exceeds the configured size limit.",
    );
  }
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function actor(
  id: string | undefined,
  displayName: string | undefined,
): NormalizedActor | undefined {
  if (
    id === undefined &&
    (displayName === undefined || displayName.trim() === "")
  ) {
    return undefined;
  }
  return {
    externalId: id,
    displayName: displayName?.trim() || undefined,
    kind: "person",
  };
}

function attachments(
  values: readonly {
    readonly id: string;
    readonly fileName?: string;
    readonly mediaType?: string;
    readonly contentLength?: number;
  }[],
  connectorInstanceId: string,
  ticketId: string,
): AttachmentMetadata[] {
  return values.map((value) => ({
    reference: jitbitAttachmentReference(
      connectorInstanceId,
      ticketId,
      value.id,
    ),
    fileName: value.fileName,
    mediaType: value.mediaType,
    contentLength: value.contentLength,
  }));
}

function uniqueAttachments(
  values: readonly AttachmentMetadata[],
): AttachmentMetadata[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = [
      value.reference.connectorInstanceId,
      value.reference.resourceType,
      value.reference.externalId,
    ].join("\u0000");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

type JitbitAttachment = JitbitTicket["Attachments"][number];

function safeFileName(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

function safeMediaType(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  return value.toLowerCase();
}

function declaredMetadata(
  attachment: JitbitAttachment,
): AttachmentOccurrence["declared"] {
  const fileName = safeFileName(attachment.fileName);
  const mediaType = safeMediaType(attachment.mediaType);
  const value = {
    ...(fileName === undefined ? {} : { fileName }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(attachment.contentLength === undefined
      ? {}
      : { contentLength: attachment.contentLength }),
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

function declaredAttachmentOccurrences(input: {
  readonly values: readonly JitbitAttachment[];
  readonly owner: AttachmentOwner;
  readonly connectorInstanceId: string;
  readonly ticketId: string;
}): AttachmentOccurrence[] {
  return input.values.map((attachment, ordinal) => {
    const declared = declaredMetadata(attachment);
    return {
      owner: input.owner,
      ordinal,
      relation: "declaredAttachment",
      reference: jitbitAttachmentReference(
        input.connectorInstanceId,
        input.ticketId,
        attachment.id,
      ),
      locator: jitbitAttachmentLocator(attachment.id),
      ...(declared === undefined ? {} : { declared }),
    };
  });
}

function inlineImageAttachmentOccurrences(input: {
  readonly body: string | undefined;
  readonly owner: AttachmentOwner;
  readonly connectorInstanceId: string;
  readonly ticketId: string;
  readonly startingOrdinal: number;
}): AttachmentOccurrence[] {
  return inlineImageAttachmentIds(input.body).map((attachmentId, index) => ({
    owner: input.owner,
    ordinal: input.startingOrdinal + index,
    relation: "inlineImage",
    reference: jitbitAttachmentReference(
      input.connectorInstanceId,
      input.ticketId,
      attachmentId,
    ),
    locator: jitbitAttachmentLocator(attachmentId),
  }));
}

/**
 * Jitbit renders ticket and comment images as <img src="/File/Get/<id>">.
 * Only image elements in non-script/non-style HTML are accepted; arbitrary links
 * remain outside this connector and cannot become attachment download requests.
 */
function inlineImageAttachmentIds(body: string | undefined): readonly string[] {
  if (body === undefined) return [];
  const content = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ");
  const ids: string[] = [];
  const imagePattern =
    /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const match of content.matchAll(imagePattern)) {
    const source = match[1] ?? match[2] ?? match[3];
    if (source === undefined) continue;
    const file = /^\/File\/Get\/([^/?#\s"'<>]+)(?:[?#][^\s"'<>]*)?$/iu.exec(
      source,
    )?.[1];
    if (file === undefined) continue;
    try {
      const attachmentId = decodeURIComponent(file);
      // `jitbitAttachmentLocator` supplies the authoritative safe-ID check without
      // ever persisting a URL/path as the locator.
      jitbitAttachmentLocator(attachmentId);
      ids.push(attachmentId);
    } catch {
      // Malformed inline references are untrusted source content, not a reason to
      // fail an otherwise usable case. The attachment pipeline receives no request.
    }
  }
  return ids;
}

export function publicationMarker(marker: string): string {
  if (!publicationMarkerValuePattern.test(marker)) {
    throw new ConnectorProtocolError(
      "Jitbit publication markers must use a safe stable identifier.",
    );
  }
  return `${publicationMarkerPrefix}${marker}${publicationMarkerSuffix}`;
}

export function hasCaseWeaverPublicationMarker(
  body: string | undefined,
): boolean {
  return body !== undefined && publicationMarkerPattern.test(body);
}

export function summaryFingerprint(
  summary: JitbitTicketSummary,
): ReturnType<typeof versionedOpaqueValue> {
  const updatedAt = parseTimestamp(summary.LastUpdated);
  if (updatedAt !== undefined) {
    return versionedOpaqueValue("jitbit.last-updated.v1", updatedAt);
  }
  return versionedOpaqueValue(
    "jitbit.summary-sha256.v1",
    sha256CanonicalJson({
      id: summary.IssueID,
      status: summary.Status,
      subject: summary.Subject,
      issueDate: summary.IssueDate,
    }),
  );
}

function commentMessage(
  comment: JitbitComment,
  sequence: number,
  connectorInstanceId: string,
  ticketId: string,
  maximumCharacters: number,
): NormalizedCaseMessage {
  const caseReference = {
    connectorInstanceId,
    resourceType: "case",
    externalId: ticketId,
  } satisfies ExternalReference;
  const owner = {
    kind: "caseMessage" as const,
    case: caseReference,
    messageExternalId: comment.CommentID,
  } satisfies AttachmentOwner;
  const declaredOccurrences = declaredAttachmentOccurrences({
    values: comment.Attachments,
    owner,
    connectorInstanceId,
    ticketId,
  });
  return {
    externalId: comment.CommentID,
    sequence,
    author: actor(comment.UserID, comment.UserName),
    sentAt: parseTimestamp(comment.CommentDate),
    visibility: comment.ForTechsOnly ? "internal" : "public",
    body: {
      format: "html",
      normalizedText: normalizeHtml(comment.Body, maximumCharacters),
    },
    attachments: attachments(
      comment.Attachments,
      connectorInstanceId,
      ticketId,
    ),
    attachmentOccurrences: [
      ...declaredOccurrences,
      ...inlineImageAttachmentOccurrences({
        body: comment.Body,
        owner,
        connectorInstanceId,
        ticketId,
        startingOrdinal: declaredOccurrences.length,
      }),
    ],
  };
}

function sortedContentComments(
  comments: readonly JitbitComment[],
): readonly JitbitComment[] {
  return comments
    .filter(
      (comment) =>
        !comment.IsSystem && !hasCaseWeaverPublicationMarker(comment.Body),
    )
    .toSorted((left, right) => {
      const leftTime = parseTimestamp(left.CommentDate) ?? "";
      const rightTime = parseTimestamp(right.CommentDate) ?? "";
      return (
        leftTime.localeCompare(rightTime) ||
        left.CommentID.localeCompare(right.CommentID)
      );
    });
}

export function mapNormalizedCase(input: {
  readonly ticket: JitbitTicket;
  readonly comments: readonly JitbitComment[];
  readonly connectorInstanceId: string;
  readonly maximumCharacters: number;
}): NormalizedCase {
  const { ticket, comments, connectorInstanceId, maximumCharacters } = input;
  const contentComments = sortedContentComments(comments);
  const caseReference = {
    connectorInstanceId,
    resourceType: "case",
    externalId: ticket.IssueID,
  } satisfies ExternalReference;
  const ticketMessageExternalId = `ticket:${ticket.IssueID}`;
  const ticketOwner = {
    kind: "caseMessage" as const,
    case: caseReference,
    messageExternalId: ticketMessageExternalId,
  } satisfies AttachmentOwner;
  const ticketAttachments = attachments(
    ticket.Attachments,
    connectorInstanceId,
    ticket.IssueID,
  );
  const commentAttachments = contentComments.flatMap((comment) =>
    attachments(comment.Attachments, connectorInstanceId, ticket.IssueID),
  );
  const ticketDeclaredOccurrences = declaredAttachmentOccurrences({
    values: ticket.Attachments,
    owner: ticketOwner,
    connectorInstanceId,
    ticketId: ticket.IssueID,
  });
  const messages: NormalizedCaseMessage[] = [
    {
      externalId: ticketMessageExternalId,
      sequence: 0,
      author: actor(ticket.UserID, ticket.UserName),
      sentAt: parseTimestamp(ticket.IssueDate),
      visibility: "public",
      body: {
        format: "html",
        normalizedText: normalizeHtml(ticket.Body, maximumCharacters),
      },
      attachments: ticketAttachments,
      attachmentOccurrences: [
        ...ticketDeclaredOccurrences,
        ...inlineImageAttachmentOccurrences({
          body: ticket.Body,
          owner: ticketOwner,
          connectorInstanceId,
          ticketId: ticket.IssueID,
          startingOrdinal: ticketDeclaredOccurrences.length,
        }),
      ],
    },
    ...contentComments.map((comment, index) =>
      commentMessage(
        comment,
        index + 1,
        connectorInstanceId,
        ticket.IssueID,
        maximumCharacters,
      ),
    ),
  ];
  const tags =
    typeof ticket.Tags === "string"
      ? ticket.Tags.split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      : ticket.Tags?.map((tag) => tag.trim()).filter(Boolean);
  const resolutionSummary = normalizeHtml(
    ticket.ResolutionText ?? ticket.Resolution,
    maximumCharacters,
  );

  return {
    reference: caseReference,
    subject: ticket.Subject?.trim() || undefined,
    lifecycle: lifecycleFor(ticket.Status),
    priority: priorityFor(ticket.Priority),
    category: ticket.Category?.trim() || undefined,
    tags: tags?.length === 0 ? undefined : tags,
    actors: {
      requester: actor(ticket.UserID, ticket.UserName),
      assignee: actor(ticket.TechID, ticket.TechName),
    },
    timestamps: {
      createdAt: parseTimestamp(ticket.IssueDate),
      updatedAt: parseTimestamp(ticket.LastUpdated),
      resolvedAt: parseTimestamp(ticket.ResolvedDate),
      closedAt: parseTimestamp(ticket.ClosedDate),
    },
    messages,
    attachments: uniqueAttachments([
      ...ticketAttachments,
      ...commentAttachments,
    ]),
    resolution:
      resolutionSummary.length === 0
        ? undefined
        : { kind: "fixed", summary: resolutionSummary },
  };
}

function section(name: string, content: readonly string[]): string {
  return `## ${name}\n${content.filter(Boolean).join("\n\n")}`;
}

export function mapResolvedKnowledgeDocument(input: {
  readonly ticket: JitbitTicket;
  readonly comments: readonly JitbitComment[];
  readonly connectorInstanceId: string;
  readonly baseUrl: string;
  readonly maximumCharacters: number;
}): KnowledgeDocument {
  const { ticket, comments, connectorInstanceId, baseUrl, maximumCharacters } =
    input;
  const contentComments = sortedContentComments(comments);
  const documentReference = {
    connectorInstanceId,
    resourceType: "resolved-case",
    externalId: ticket.IssueID,
  } satisfies ExternalReference;
  const owner = {
    kind: "knowledgeDocument" as const,
    document: documentReference,
  } satisfies AttachmentOwner;
  const investigation = contentComments.map((comment) =>
    normalizeHtml(comment.Body, maximumCharacters),
  );
  const resolution = normalizeHtml(
    ticket.ResolutionText ?? ticket.Resolution,
    maximumCharacters,
  );
  const declared = [
    ...ticket.Attachments,
    ...contentComments.flatMap((comment) => comment.Attachments),
  ];
  const declaredOccurrences = declaredAttachmentOccurrences({
    values: declared,
    owner,
    connectorInstanceId,
    ticketId: ticket.IssueID,
  });
  const inlineBodies = [
    ticket.Body,
    ...contentComments.map((comment) => comment.Body),
  ];
  const inline = inlineBodies.flatMap((body, index) =>
    inlineImageAttachmentOccurrences({
      body,
      owner,
      connectorInstanceId,
      ticketId: ticket.IssueID,
      startingOrdinal:
        declaredOccurrences.length +
        inlineBodies
          .slice(0, index)
          .reduce(
            (ordinal, previous) =>
              ordinal + inlineImageAttachmentIds(previous).length,
            0,
          ),
    }),
  );
  return {
    reference: documentReference,
    title: ticket.Subject?.trim() || `Jitbit ticket ${ticket.IssueID}`,
    body: {
      format: "markdown",
      normalizedText: [
        section("Problem", [normalizeHtml(ticket.Body, maximumCharacters)]),
        section("Investigation", investigation),
        section("Resolution", resolution === "" ? [] : [resolution]),
      ].join("\n\n"),
    },
    attachments: uniqueAttachments(
      attachments(declared, connectorInstanceId, ticket.IssueID),
    ),
    attachmentOccurrences: [...declaredOccurrences, ...inline],
    provenance: {
      sourceUrl: `${baseUrl}/Ticket/${encodeURIComponent(ticket.IssueID)}`,
      sourceLocator: `ticket/${ticket.IssueID}`,
    },
  };
}
