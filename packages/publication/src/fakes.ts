import type {
  AnalysisDestination,
  ExistingPublication,
  FindPublicationRequest,
  PublishRequest,
  PublishResult,
} from "@caseweaver/connector-sdk";

import type { PublicationDestinationResolver } from "./ports.js";

function targetKey(request: FindPublicationRequest | PublishRequest): string {
  const { connectorInstanceId, resourceType, externalId } = request.target;
  return `${connectorInstanceId}\u0000${resourceType}\u0000${externalId}\u0000${request.marker.value}`;
}

export class InMemoryAnalysisDestination implements AnalysisDestination {
  private readonly publications = new Map<string, ExistingPublication>();
  public readonly findRequests: FindPublicationRequest[] = [];
  public readonly publishRequests: PublishRequest[] = [];
  public nextPublishResult: "published" | "outcome_unknown" = "published";

  public async findPublication(
    request: FindPublicationRequest,
  ): Promise<ExistingPublication | null> {
    this.findRequests.push(request);
    return this.publications.get(targetKey(request)) ?? null;
  }

  public async publish(request: PublishRequest): Promise<PublishResult> {
    this.publishRequests.push(request);
    if (this.nextPublishResult === "outcome_unknown") {
      return { status: "outcome_unknown", requestId: request.requestId };
    }

    const key = targetKey(request);
    const existing = this.publications.get(key);
    const publication =
      existing ??
      Object.freeze({
        marker: request.marker,
        reference: Object.freeze({
          connectorInstanceId: request.target.connectorInstanceId,
          resourceType: "publication",
          externalId: `publication-${this.publications.size + 1}`,
        }),
      });
    this.publications.set(key, publication);
    return {
      status: "published",
      receipt: {
        reference: publication.reference,
        marker: publication.marker,
        requestId: request.requestId,
      },
    };
  }
}

export class InMemoryPublicationDestinationResolver
  implements PublicationDestinationResolver
{
  private readonly destinations = new Map<string, AnalysisDestination>();
  public readonly resolveRequests: Array<{
    readonly workspaceId: import("@caseweaver/domain").WorkspaceId;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
  }> = [];

  public register(
    connectorInstanceId: string,
    destination: AnalysisDestination,
  ): void {
    if (this.destinations.has(connectorInstanceId)) {
      throw new Error(
        `A publication destination is already registered for "${connectorInstanceId}".`,
      );
    }
    this.destinations.set(connectorInstanceId, destination);
  }

  public async resolve(
    input: Parameters<PublicationDestinationResolver["resolve"]>[0],
  ): Promise<AnalysisDestination | undefined> {
    this.resolveRequests.push({
      workspaceId: input.workspaceId,
      connectorRegistrationId: input.connectorRegistrationId,
      connectorConfigurationVersionId: input.connectorConfigurationVersionId,
    });
    return this.destinations.get(input.connectorRegistrationId);
  }
}
