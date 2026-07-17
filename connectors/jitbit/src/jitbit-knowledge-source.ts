import {
  ConnectorCancelledError,
  ConnectorProtocolError,
  type DiscoveredKnowledgeItem,
  type DiscoveryPage,
  type KnowledgeDocument,
  type KnowledgeSource,
  type LoadKnowledgeRequest,
  type VersionedOpaqueValue,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";
import type { JitbitClient } from "./client.js";
import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
} from "./config.js";
import {
  isResolvedSummary,
  mapResolvedKnowledgeDocument,
  summaryFingerprint,
} from "./mapping.js";
import {
  type JitbitResolvedKnowledgeFilter,
  parseJitbitResolvedKnowledgeFilter,
} from "./resolved-knowledge-filter.js";

const cursorVersion = "jitbit.discovery.v1";
const resourceType = "resolved-case";

interface DiscoveryCursor {
  readonly updatedFrom?: string;
  readonly offset: number;
}

function parseCursor(
  cursor: VersionedOpaqueValue | undefined,
  configuration: JitbitConfiguration,
): DiscoveryCursor {
  if (cursor === undefined) {
    return {
      updatedFrom: configuration.settings.initialUpdatedFrom,
      offset: 0,
    };
  }
  if (cursor.version !== cursorVersion) {
    throw new ConnectorProtocolError(
      "The Jitbit source received an incompatible discovery cursor.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(cursor.value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isInteger((parsed as { offset?: unknown }).offset) ||
      (parsed as { offset: number }).offset < 0 ||
      ((parsed as { updatedFrom?: unknown }).updatedFrom !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/u.test(
          (parsed as { updatedFrom: string }).updatedFrom,
        ))
    ) {
      throw new Error("Invalid cursor.");
    }
    const state = parsed as DiscoveryCursor;
    return {
      ...state,
      updatedFrom:
        state.offset === 0 && state.updatedFrom !== undefined
          ? overlapDate(
              state.updatedFrom,
              configuration.settings.updatedFromOverlapDays,
            )
          : state.updatedFrom,
    };
  } catch {
    throw new ConnectorProtocolError("The Jitbit discovery cursor is invalid.");
  }
}

function overlapDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function cursor(value: DiscoveryCursor): VersionedOpaqueValue {
  return versionedOpaqueValue(cursorVersion, JSON.stringify(value));
}

function nextWatermark(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function assertReference(
  reference: LoadKnowledgeRequest["reference"],
  configuration: JitbitConfiguration,
): string {
  if (
    reference.connectorInstanceId !==
      configuration.settings.connectorInstanceId ||
    reference.resourceType !== resourceType
  ) {
    throw new ConnectorProtocolError(
      "The requested knowledge item does not belong to this Jitbit source.",
    );
  }
  return reference.externalId;
}

export interface JitbitKnowledgeSourceOptions {
  readonly configuration: JitbitConfiguration;
  readonly client: JitbitClient;
  /**
   * A source-version projection owned by Jitbit, not connector-instance settings.
   * Runtime composition injects the immutable source filter when that projection is
   * available; the safe default excludes non-terminal cases.
   */
  readonly resolvedKnowledgeFilter?: JitbitResolvedKnowledgeFilter;
  readonly now?: () => Date;
}

export class JitbitKnowledgeSource implements KnowledgeSource {
  private readonly configuration: JitbitConfiguration;
  private readonly client: JitbitClient;
  private readonly resolvedKnowledgeFilter: JitbitResolvedKnowledgeFilter;
  private readonly now: () => Date;

  public constructor(options: JitbitKnowledgeSourceOptions) {
    this.configuration = jitbitConfigurationSchema.parse(options.configuration);
    this.client = options.client;
    this.resolvedKnowledgeFilter = parseJitbitResolvedKnowledgeFilter(
      options.resolvedKnowledgeFilter,
    );
    this.now = options.now ?? (() => new Date());
  }

  public async *discover(request: {
    readonly cursor?: VersionedOpaqueValue;
    readonly pageSize?: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<DiscoveryPage<DiscoveredKnowledgeItem>> {
    if (request.signal.aborted) throw new ConnectorCancelledError();
    const size =
      request.pageSize ?? this.configuration.settings.discoveryPageSize;
    if (!Number.isInteger(size) || size < 1 || size > 300) {
      throw new ConnectorProtocolError(
        "Jitbit discovery requires a page size between 1 and 300.",
      );
    }
    let state = parseCursor(request.cursor, this.configuration);
    while (true) {
      const summaries = await this.client.getTicketSummaries({
        count: size,
        offset: state.offset,
        updatedFrom: state.updatedFrom,
        signal: request.signal,
      });
      if (request.signal.aborted) throw new ConnectorCancelledError();
      const complete = summaries.length < size;
      const nextCursor = complete
        ? cursor({ updatedFrom: nextWatermark(this.now()), offset: 0 })
        : cursor({ ...state, offset: state.offset + summaries.length });
      yield {
        mode: "delta",
        events: summaries
          .filter((summary) => this.isEligible(summary))
          .map((summary) => ({
            kind: "upsert" as const,
            item: {
              reference: {
                connectorInstanceId:
                  this.configuration.settings.connectorInstanceId,
                resourceType,
                externalId: summary.IssueID,
              },
              fingerprint: summaryFingerprint(summary),
            },
          })),
        nextCursor,
        complete,
      };
      if (complete) return;
      state = { ...state, offset: state.offset + summaries.length };
    }
  }

  public async load(request: LoadKnowledgeRequest): Promise<KnowledgeDocument> {
    if (request.signal.aborted) throw new ConnectorCancelledError();
    const id = assertReference(request.reference, this.configuration);
    const [ticket, comments] = await Promise.all([
      this.client.getTicket({ id, signal: request.signal }),
      this.client.getComments({ id, signal: request.signal }),
    ]);
    if (request.signal.aborted) throw new ConnectorCancelledError();
    if (ticket.IssueID !== id) {
      throw new ConnectorProtocolError(
        "Jitbit returned a ticket with a different ID than requested.",
      );
    }
    if (!this.isEligible(ticket)) {
      throw new ConnectorProtocolError(
        "Jitbit returned a case excluded by this knowledge-source filter.",
      );
    }
    return mapResolvedKnowledgeDocument({
      ticket,
      comments,
      connectorInstanceId: this.configuration.settings.connectorInstanceId,
      baseUrl: this.configuration.settings.baseUrl,
      maximumCharacters: this.configuration.settings.maximumTicketCharacters,
    });
  }

  private isEligible(
    summary: Parameters<typeof isResolvedSummary>[0],
  ): boolean {
    return (
      !this.resolvedKnowledgeFilter.resolvedOrClosedOnly ||
      isResolvedSummary(summary)
    );
  }
}
