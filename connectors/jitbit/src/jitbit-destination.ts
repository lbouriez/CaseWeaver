import {
  ConnectorCancelledError,
  ConnectorProtocolError,
  ConnectorRemoteError,
  type AnalysisDestination,
  type ExistingPublication,
  type FindPublicationRequest,
  type PublishRequest,
  type PublishResult,
} from "@caseweaver/connector-sdk";

import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
} from "./config.js";
import type { JitbitClient } from "./client.js";
import { publicationMarker } from "./mapping.js";

const caseResourceType = "case";

function assertTarget(
  target: FindPublicationRequest["target"],
  configuration: JitbitConfiguration,
): string {
  if (
    target.connectorInstanceId !== configuration.settings.connectorInstanceId ||
    target.resourceType !== caseResourceType
  ) {
    throw new ConnectorProtocolError(
      "The requested publication target does not belong to this Jitbit destination.",
    );
  }
  return target.externalId;
}

export interface JitbitAnalysisDestinationOptions {
  readonly configuration: JitbitConfiguration;
  readonly client: JitbitClient;
}

export class JitbitAnalysisDestination implements AnalysisDestination {
  private readonly configuration: JitbitConfiguration;
  private readonly client: JitbitClient;

  public constructor(options: JitbitAnalysisDestinationOptions) {
    this.configuration = jitbitConfigurationSchema.parse(options.configuration);
    this.client = options.client;
  }

  public async findPublication(
    request: FindPublicationRequest,
  ): Promise<ExistingPublication | null> {
    if (request.signal.aborted) throw new ConnectorCancelledError();
    const ticketId = assertTarget(request.target, this.configuration);
    const expectedMarker = publicationMarker(request.marker.value);
    const comments = await this.client.getComments({
      id: ticketId,
      signal: request.signal,
    });
    if (request.signal.aborted) throw new ConnectorCancelledError();
    const existing = comments.find((comment) =>
      comment.Body?.includes(expectedMarker),
    );
    if (existing === undefined) return null;
    return {
      marker: request.marker,
      reference: {
        connectorInstanceId: this.configuration.settings.connectorInstanceId,
        resourceType: "comment",
        externalId: existing.CommentID,
      },
    };
  }

  public async publish(request: PublishRequest): Promise<PublishResult> {
    if (request.signal.aborted) throw new ConnectorCancelledError();
    if (request.publication.visibility !== "internal") {
      throw new ConnectorProtocolError(
        "Jitbit publication only supports internal comments.",
      );
    }
    const ticketId = assertTarget(request.target, this.configuration);
    const existing = await this.findPublication({
      target: request.target,
      marker: request.marker,
      signal: request.signal,
      requestId: request.requestId,
    });
    if (existing !== null) {
      return {
        status: "published",
        receipt: {
          reference: existing.reference,
          marker: request.marker,
          requestId: request.requestId,
        },
      };
    }
    try {
      const commentId = await this.client.postInternalComment({
        id: ticketId,
        body: `${request.publication.body}\n\n${publicationMarker(request.marker.value)}`,
        signal: request.signal,
      });
      return {
        status: "published",
        receipt: {
          reference: {
            connectorInstanceId:
              this.configuration.settings.connectorInstanceId,
            resourceType: "comment",
            externalId: commentId,
          },
          marker: request.marker,
          requestId: request.requestId,
        },
      };
    } catch (error) {
      if (
        error instanceof ConnectorRemoteError &&
        (error.category === "timeout" || error.category === "network")
      ) {
        return {
          status: "outcome_unknown",
          requestId: error.details?.requestId ?? request.requestId,
        };
      }
      throw error;
    }
  }
}
