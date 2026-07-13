import {
  ConnectorProtocolError,
  sha256CanonicalJson,
  type AttachmentMetadata,
  type ExternalReference,
  type KnowledgeDocument,
  type NormalizedActor,
  type NormalizedCase,
  type NormalizedCaseMessage,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";

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

function attachmentReference(
  connectorInstanceId: string,
  ticketId: string,
  attachmentId: string,
): ExternalReference {
  return {
    connectorInstanceId,
    resourceType: "attachment",
    externalId: `${ticketId}:${attachmentId}`,
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
    reference: attachmentReference(connectorInstanceId, ticketId, value.id),
    fileName: value.fileName,
    mediaType: value.mediaType,
    contentLength: value.contentLength,
  }));
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
  const ticketAttachments = attachments(
    ticket.Attachments,
    connectorInstanceId,
    ticket.IssueID,
  );
  const commentAttachments = contentComments.flatMap((comment) =>
    attachments(comment.Attachments, connectorInstanceId, ticket.IssueID),
  );
  const messages: NormalizedCaseMessage[] = [
    {
      externalId: `ticket:${ticket.IssueID}`,
      sequence: 0,
      author: actor(ticket.UserID, ticket.UserName),
      sentAt: parseTimestamp(ticket.IssueDate),
      visibility: "public",
      body: {
        format: "html",
        normalizedText: normalizeHtml(ticket.Body, maximumCharacters),
      },
      attachments: ticketAttachments,
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
    reference: {
      connectorInstanceId,
      resourceType: "case",
      externalId: ticket.IssueID,
    },
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
    attachments: [...ticketAttachments, ...commentAttachments],
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
  const investigation = contentComments.map((comment) =>
    normalizeHtml(comment.Body, maximumCharacters),
  );
  const resolution = normalizeHtml(
    ticket.ResolutionText ?? ticket.Resolution,
    maximumCharacters,
  );
  return {
    reference: {
      connectorInstanceId,
      resourceType: "resolved-case",
      externalId: ticket.IssueID,
    },
    title: ticket.Subject?.trim() || `Jitbit ticket ${ticket.IssueID}`,
    body: {
      format: "markdown",
      normalizedText: [
        section("Problem", [normalizeHtml(ticket.Body, maximumCharacters)]),
        section("Investigation", investigation),
        section("Resolution", resolution === "" ? [] : [resolution]),
      ].join("\n\n"),
    },
    attachments: [
      ...attachments(ticket.Attachments, connectorInstanceId, ticket.IssueID),
      ...contentComments.flatMap((comment) =>
        attachments(comment.Attachments, connectorInstanceId, ticket.IssueID),
      ),
    ],
    provenance: {
      sourceUrl: `${baseUrl}/Ticket/${encodeURIComponent(ticket.IssueID)}`,
      sourceLocator: `ticket/${ticket.IssueID}`,
    },
  };
}
