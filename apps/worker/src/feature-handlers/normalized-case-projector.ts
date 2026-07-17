import type { Clock } from "@caseweaver/application";
import {
  attachmentOccurrenceIdentity,
  normalizedCaseRevision,
  normalizedCaseSchema,
  sha256CanonicalJson,
} from "@caseweaver/connector-sdk";
import { utcInstant } from "@caseweaver/domain";

import type { CaseSnapshotProjector } from "./analysis-trigger.js";

const maximumTitleCharacters = 16_000;
const maximumSummaryCharacters = 64_000;

/** A redacted boundary failure; normalized connector payloads never reach logs. */
export class NormalizedCaseProjectionError extends Error {
  public readonly code = "analysis.trigger.captureInvalid";
  public readonly retryable = false;

  public constructor() {
    super("The captured case cannot be normalized for analysis.");
    this.name = "NormalizedCaseProjectionError";
  }
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function caseTitle(input: {
  readonly subject?: string;
  readonly resourceType: string;
  readonly externalId: string;
}): string {
  const title = input.subject?.trim();
  return bounded(
    title === undefined || title.length === 0
      ? `${input.resourceType}:${input.externalId}`
      : title,
    maximumTitleCharacters,
  );
}

function caseSummary(input: {
  readonly subject?: string;
  readonly resolution?: { readonly summary?: string };
  readonly messages: readonly {
    readonly body: { readonly normalizedText: string };
  }[];
}): string {
  const candidate =
    input.resolution?.summary ??
    input.messages.find((message) => message.body.normalizedText.trim() !== "")
      ?.body.normalizedText ??
    input.subject ??
    "No case summary was provided.";
  const summary = bounded(candidate.trim(), maximumSummaryCharacters);
  return summary === "" ? "No case summary was provided." : summary;
}

/**
 * Projects a connector-neutral `NormalizedCase` into immutable capture content.
 * It passes only opaque attachment references to PostgreSQL, which resolves
 * them to already verified derivatives in the new-snapshot transaction.
 */
export class NormalizedCaseSnapshotProjector implements CaseSnapshotProjector {
  public constructor(private readonly clock: Clock) {}

  public async project(
    input: Parameters<CaseSnapshotProjector["project"]>[0],
  ): Promise<Awaited<ReturnType<CaseSnapshotProjector["project"]>>> {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("The operation was aborted.");
    }
    try {
      const normalized = normalizedCaseSchema.parse(input.normalizedCase);
      if (
        normalized.reference.connectorInstanceId !==
          input.request.target.connectorInstanceId ||
        normalized.reference.resourceType !==
          input.request.target.resourceType ||
        normalized.reference.externalId !== input.request.target.externalId
      ) {
        throw new NormalizedCaseProjectionError();
      }
      const attachmentReferences = new Map<
        string,
        Readonly<{
          readonly connectorRegistrationId: string;
          readonly resourceType: string;
          readonly externalId: string;
          readonly occurrenceIdentity?: string;
        }>
      >();
      const occurrences = [
        ...(normalized.attachmentOccurrences ?? []),
        ...normalized.messages.flatMap(
          (message) => message.attachmentOccurrences ?? [],
        ),
      ];
      const attachments: readonly Readonly<{
        readonly reference: {
          readonly connectorInstanceId: string;
          readonly resourceType: string;
          readonly externalId: string;
        };
        readonly occurrenceIdentity?: string;
      }>[] =
        occurrences.length === 0
          ? [
              ...normalized.attachments,
              ...normalized.messages.flatMap((message) => message.attachments),
            ].map((attachment) => Object.freeze({ reference: attachment.reference }))
          : occurrences.map((occurrence) =>
              Object.freeze({
                reference: occurrence.reference,
                occurrenceIdentity: attachmentOccurrenceIdentity(occurrence),
              }),
            );
      for (const attachment of attachments) {
        if (
          attachment.reference.connectorInstanceId !==
          input.request.connectorRegistrationId
        ) {
          throw new NormalizedCaseProjectionError();
        }
        attachmentReferences.set(
          attachment.occurrenceIdentity ??
            `${attachment.reference.resourceType}\u0000${attachment.reference.externalId}`,
          Object.freeze({
            connectorRegistrationId: attachment.reference.connectorInstanceId,
            resourceType: attachment.reference.resourceType,
            externalId: attachment.reference.externalId,
            ...(attachment.occurrenceIdentity === undefined
              ? {}
              : { occurrenceIdentity: attachment.occurrenceIdentity }),
          }),
        );
      }
      const messages = normalized.messages
        .filter((message) => message.body.normalizedText.length > 0)
        .map((message) =>
          Object.freeze({
            id: `case-message:${sha256CanonicalJson({
              externalId: message.externalId,
              sequence: message.sequence,
            })}`,
            content: message.body.normalizedText,
            contentHash: sha256CanonicalJson({
              externalId: message.externalId,
              sequence: message.sequence,
              body: message.body.normalizedText,
            }),
          }),
        );
      const revision = normalizedCaseRevision(normalized);
      return Object.freeze({
        revision,
        capturedAt: utcInstant(this.clock.now()),
        title: caseTitle({
          subject: normalized.subject,
          resourceType: normalized.reference.resourceType,
          externalId: normalized.reference.externalId,
        }),
        summary: caseSummary(normalized),
        contentHash: revision,
        messages: Object.freeze(messages),
        attachmentReferences: Object.freeze(
          [...attachmentReferences.values()].toSorted((left, right) =>
            `${left.occurrenceIdentity ?? ""}\u0000${left.resourceType}\u0000${left.externalId}`.localeCompare(
              `${right.occurrenceIdentity ?? ""}\u0000${right.resourceType}\u0000${right.externalId}`,
            ),
          ),
        ),
      });
    } catch (error) {
      if (error instanceof NormalizedCaseProjectionError) throw error;
      if (input.signal.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("The operation was aborted.");
      }
      throw new NormalizedCaseProjectionError();
    }
  }
}
